import { getAddress, parseEther, zeroAddress, type Address, type Hex, type PublicClient, type StateOverride } from "viem";
import {
  activeFactory,
  chainByKey,
  chainDisplayName,
  DEFAULT_CHAIN_KEY,
  env,
  findQuote,
  logger,
  o1Chain,
  publicClient,
  registryDrift,
  tickerCollidesWithStock,
  type ChainKey,
  type O1Quote,
} from "@o1bot/shared";
import { factoryAbiFor } from "./abis";
import { classifyError, type LaunchError, type LaunchErrorKind } from "./errors";
import { readFactoryState, readQuoteState, readTokenBytecodeHash, type FactoryState, type QuoteState } from "./factory-state";
import { O1_LIMITS, validateTokenFields } from "./limits";
import { buildLaunchRoute, launchPoolStep, type RouteStep } from "./route";
import { discoverPrefixRoutes, type RouteCandidate } from "./route-discovery";
import { mineCreatorSalt, mineCreatorSaltB20, type MinedSalt } from "./salt";

/**
 * planLaunch: everything up to (but never including) signing.
 *
 * Reads the live factory at one block, validates the pair and fields, mines
 * a `01` salt, builds the exact call, simulates it as the creator, estimates
 * gas and checks funding. With a dev buy, every discovered route is
 * simulated and the one with the largest output wins. The returned plan is
 * what the signer later executes verbatim. Nothing here broadcasts.
 */

export type LaunchParams = {
  tokenName: string;
  tokenSymbol: string;
  tokenContractURI: string;
  creatorSalt: Hex;
  quoteToken: Address;
  expectedConfigVersion: bigint;
  deadline: bigint;
  metadataEditable: boolean;
  metadataKeys: readonly string[];
  metadataValues: readonly string[];
};

export type LaunchBuyParams = {
  fundingToken: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  routeData: Hex;
};

export type LaunchCall =
  | { functionName: "createLaunch"; args: readonly [LaunchParams]; value: bigint }
  | { functionName: "createLaunchAndBuy"; args: readonly [LaunchParams, LaunchBuyParams]; value: bigint };

export type LaunchRequest = {
  /** The user's Privy wallet: msg.sender, fee payer, on-chain creator. */
  creator: Address;
  name: string;
  symbol: string;
  /** Pinned metadata URI (see prepareTokenMetadata). */
  tokenContractURI: string;
  /** Pair symbol ("ETH", "USDG", "NVDA") or quote address. */
  pair: string;
  /** Native wei for the atomic dev buy; 0 or undefined = plain createLaunch. */
  devBuyWei?: bigint;
  metadataEditable?: boolean;
  deadlineSeconds?: number;
  /** Slippage applied to the simulated dev-buy output. Default: DEV_BUY_SLIPPAGE_BPS (500 = 5%). */
  slippageBps?: number;
  /** Chain to launch on; Robinhood when the post names none. */
  chain?: ChainKey;
};

export type PlanOptions = {
  client?: PublicClient;
  /** Skip the live o1 registry check (tests / offline). Never in production. */
  skipDriftCheck?: boolean;
  /** Give the creator a virtual balance during simulation (dry runs with empty wallets). */
  fundSimulation?: boolean;
  /** Deterministic salt search seed (tests). */
  saltSeed?: Hex;
};

export type PlanStage = "registry" | "fields" | "pair" | "state" | "bytecode" | "salt" | "route" | "simulate" | "gas" | "funding";

export type RouteAttempt = { label: string; hops: number; amountOut: bigint | null; error: LaunchError | null };

export type LaunchPlan = {
  chainId: number;
  factory: Address;
  blockNumber: bigint;
  blockTimestamp: bigint;
  state: FactoryState;
  quote: O1Quote;
  quoteState: QuoteState;
  /** Token creation-code hash on erc20 chains; null on Base, where the B20 precompile predicts the address. */
  bytecodeHash: Hex | null;
  salt: MinedSalt;
  params: LaunchParams;
  call: LaunchCall;
  /** Chosen dev-buy route (null for plain launches) and every candidate tried. */
  route: { label: string; steps: RouteStep[] } | null;
  routeAttempts: RouteAttempt[];
  simulation: {
    token: Address;
    poolId: Hex;
    /** Dev-buy output before slippage; null for plain launches. */
    amountOut: bigint | null;
    gas: bigint;
    gasSource: "estimate" | "fallback";
  };
  funding: {
    valueWei: bigint;
    /** Fee cap the broadcast must reuse, so the node never asks for more than what was checked here. */
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    gasWei: bigint;
    requiredWei: bigint;
    balanceWei: bigint;
    shortfallWei: bigint;
  };
};

export type PlanFailure = { ok: false; stage: PlanStage; error: LaunchError; routeAttempts?: RouteAttempt[] };
export type PlanResult = { ok: true; plan: LaunchPlan } | PlanFailure;

const ZERO_SALT = `0x${"0".repeat(64)}` as Hex;
/** ~1.3× gas observed on live Robinhood launches (1.90M plain, 2.19M with dev buy). */
const GAS_FALLBACK: Record<LaunchCall["functionName"], bigint> = { createLaunch: 2_500_000n, createLaunchAndBuy: 2_900_000n };
/**
 * Headroom on the fee estimate between planning and broadcast. Robinhood
 * charges only the block base fee (Arbitrum Nitro refunds the rest of the
 * cap), so a generous cap costs nothing when unused; it only raises the
 * balance the funding check asks for. The base fee here moves by about 2%
 * per block, so 1.5× over viem's own 1.2× estimate is ample.
 */
const FEE_CAP_PCT = 150n;
/** Simulation failures that are about the launch itself, not the route: stop trying other routes. */
const ROUTE_INDEPENDENT_KINDS: ReadonlySet<LaunchErrorKind> = new Set([
  "stale_config",
  "expired",
  "pair_not_registered",
  "creation_disabled",
  "bad_suffix",
  "salt_used",
  "bad_payment",
  "bad_token_fields",
  "token_check_failed",
  "insufficient_balance",
]);

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function failure(stage: PlanStage, kind: LaunchErrorKind, message: string, extra?: Partial<LaunchError>, routeAttempts?: RouteAttempt[]): PlanFailure {
  return { ok: false, stage, error: { kind, message, ...extra }, ...(routeAttempts ? { routeAttempts } : {}) };
}

export async function planLaunch(req: LaunchRequest, opts: PlanOptions = {}): Promise<PlanResult> {
  const key = req.chain ?? DEFAULT_CHAIN_KEY;
  const client = opts.client ?? publicClient(key);
  const chain = chainByKey(key);
  const factory = activeFactory(key);
  const abi = factoryAbiFor(key);
  const mode = o1Chain(key).tokenMode;
  const creator = getAddress(req.creator);

  // 1. The snapshot's factory must still be the one o1 selects for creation.
  if (!opts.skipDriftCheck) {
    try {
      const drift = await registryDrift();
      if (drift.length > 0) {
        return failure("registry", "registry_drift", `config/o1.json is stale for ${drift.map((d) => d.key).join(", ")}; run pnpm o1:sync and pnpm abi:vendor`);
      }
    } catch (err) {
      return failure("registry", "rpc_error", `could not verify the o1 registry: ${msg(err)}`);
    }
  }

  // 2. Token fields and o1bot's stock-collision rule.
  const fields = validateTokenFields({ name: req.name, symbol: req.symbol });
  if (!fields.ok) return failure("fields", "bad_token_fields", fields.reason);
  const symbol = req.symbol.trim();
  if (tickerCollidesWithStock(key, symbol)) {
    return failure("fields", "ticker_collides_with_stock", `${symbol} is a registered stock token symbol on this factory`);
  }

  // 3. Pair from the snapshot catalog, confirmed live below.
  const quote = findQuote(key, req.pair);
  if (!quote) return failure("pair", "pair_not_registered", `pair ${req.pair} is not registered on the active factory`);

  // 4. Live factory state at one block.
  let block: { number: bigint; timestamp: bigint };
  let state: FactoryState;
  let quoteState: QuoteState;
  try {
    const b = await client.getBlock();
    block = { number: b.number, timestamp: b.timestamp };
    state = await readFactoryState(client, factory, block.number, mode);
    quoteState = await readQuoteState(client, factory, quote.address, block.number);
  } catch (err) {
    return failure("state", "rpc_error", `factory read failed: ${msg(err)}`);
  }
  if (!state.launchCreationEnabled) return failure("state", "creation_disabled", "launch creation is disabled on the active factory");
  if (state.tokenAddressSuffix !== 1) return failure("state", "config_error", `unexpected TOKEN_ADDRESS_SUFFIX ${state.tokenAddressSuffix}`);
  if (!quoteState.registered) {
    return failure("state", "pair_not_registered", `${quote.symbol} is no longer registered (revision ${quoteState.revision})`);
  }
  const snapshot = o1Chain(key).contracts;
  const deployerDrift = mode === "erc20" && (!snapshot.launchTokenDeployer || !state.tokenDeployer || getAddress(snapshot.launchTokenDeployer) !== state.tokenDeployer);
  if (deployerDrift || !snapshot.hook || getAddress(snapshot.hook) !== state.hook) {
    return failure("state", "config_error", "live token deployer or hook differ from config/o1.json; run pnpm o1:sync and pnpm abi:vendor");
  }

  // 5. Bytecode hash is salt-independent: read it once with a zero salt.
  const devBuy = req.devBuyWei ?? 0n;
  const defaultDeadline = devBuy > 0n ? O1_LIMITS.devBuyDeadlineSeconds : O1_LIMITS.deadlineSeconds;
  const deadline = block.timestamp + BigInt(req.deadlineSeconds ?? defaultDeadline);
  const base: Omit<LaunchParams, "creatorSalt"> = {
    tokenName: req.name.trim(),
    tokenSymbol: symbol,
    tokenContractURI: req.tokenContractURI,
    quoteToken: quote.address,
    expectedConfigVersion: state.configVersion,
    deadline,
    metadataEditable: req.metadataEditable ?? false,
    metadataKeys: [],
    metadataValues: [],
  };
  // 6. Mine a salt whose token address ends in 01: locally from the creation-code
  // hash on erc20 chains, through the B20 precompile on Base.
  let bytecodeHash: Hex | null = null;
  let salt: MinedSalt;
  if (mode === "erc20") {
    try {
      bytecodeHash = await readTokenBytecodeHash(client, factory, { ...base, creatorSalt: ZERO_SALT }, block.number);
    } catch (err) {
      return failure("bytecode", "rpc_error", `launchTokenBytecodeHash failed: ${msg(err)}`);
    }
    if (!state.tokenDeployer) return failure("state", "config_error", "factory reports no token deployer");
    salt = mineCreatorSalt({ creator, deployer: state.tokenDeployer, bytecodeHash, suffix: state.tokenAddressSuffix, seed: opts.saltSeed });
  } else {
    const b20 = o1Chain(key).b20;
    if (!b20) return failure("state", "config_error", `config/o1.json has no b20 block for ${key}; run pnpm o1:sync`);
    try {
      salt = await mineCreatorSaltB20({ client, b20Factory: b20.factory, launchFactory: factory, creator, suffix: state.tokenAddressSuffix, seed: opts.saltSeed });
    } catch (err) {
      return failure("salt", "rpc_error", `B20 address prediction failed: ${msg(err)}`);
    }
  }
  const params: LaunchParams = { ...base, creatorSalt: salt.creatorSalt };

  const stateOverride: StateOverride | undefined = opts.fundSimulation ? [{ address: creator, balance: state.nativeLaunchFee + devBuy + parseEther("1") }] : undefined;
  const simulateBuy = async (buy: LaunchBuyParams, value: bigint) => {
    const { result } = await client.simulateContract({
      address: factory,
      abi,
      functionName: "createLaunchAndBuy",
      args: [params, buy],
      account: creator,
      value,
      stateOverride,
    });
    return result;
  };

  let call: LaunchCall;
  let route: LaunchPlan["route"] = null;
  const routeAttempts: RouteAttempt[] = [];
  let simulation: LaunchPlan["simulation"];

  if (devBuy > 0n) {
    // 7a. Dev buy: discover routes, simulate each, keep the best output.
    if (state.launchBuyAdapter === zeroAddress) return failure("state", "dev_buy_rejected", "the factory has no launch-buy adapter configured");
    let candidates: RouteCandidate[];
    try {
      candidates = await discoverPrefixRoutes(client, quote, {}, key);
    } catch (err) {
      return failure("route", "rpc_error", `route discovery failed: ${msg(err)}`);
    }
    if (candidates.length === 0) {
      return failure("route", "dev_buy_no_route", `no liquid ETH route to ${quote.symbol} exists on ${chainDisplayName(key)}; launch without a dev buy`);
    }
    const value = state.nativeLaunchFee + devBuy;
    const launchHop = launchPoolStep({ quote: quote.address, token: salt.token, hook: state.hook, tickSpacing: state.tickSpacing });
    let best: { candidate: RouteCandidate; buy: LaunchBuyParams; token: Address; poolId: Hex; amountOut: bigint } | null = null;
    for (const candidate of candidates) {
      const buy: LaunchBuyParams = { fundingToken: zeroAddress, amountIn: devBuy, minAmountOut: 1n, routeData: buildLaunchRoute(candidate.steps, launchHop) };
      try {
        const [token, poolId, amountOut] = await simulateBuy(buy, value);
        routeAttempts.push({ label: candidate.label, hops: candidate.steps.length + 1, amountOut, error: null });
        if (!best || amountOut > best.amountOut) best = { candidate, buy, token, poolId, amountOut };
      } catch (err) {
        const error = classifyError(err);
        routeAttempts.push({ label: candidate.label, hops: candidate.steps.length + 1, amountOut: null, error });
        if (ROUTE_INDEPENDENT_KINDS.has(error.kind)) return failure("simulate", error.kind, error.message, error, routeAttempts);
      }
    }
    if (!best) {
      const summary = routeAttempts.map((a) => `${a.label}: ${a.error?.errorName ?? a.error?.kind}`).join("; ");
      return failure("route", "dev_buy_no_route", `every candidate route reverted (${summary})`, undefined, routeAttempts);
    }
    if (getAddress(best.token) !== salt.token) {
      return failure("simulate", "token_check_failed", `factory would deploy ${best.token} but we predicted ${salt.token}`, undefined, routeAttempts);
    }
    // o1's own UI signs with a 25% tolerance; a few percent covers the prefix hops
    // moving in the seconds between the plan and the block without giving that much away.
    const slippage = BigInt(req.slippageBps ?? env().DEV_BUY_SLIPPAGE_BPS);
    const minAmountOut = (best.amountOut * (10_000n - slippage)) / 10_000n;
    call = { functionName: "createLaunchAndBuy", args: [params, { ...best.buy, minAmountOut: minAmountOut > 0n ? minAmountOut : 1n }], value };
    route = { label: best.candidate.label, steps: [...best.candidate.steps, launchHop] };
    simulation = { token: best.token, poolId: best.poolId, amountOut: best.amountOut, gas: 0n, gasSource: "fallback" };
  } else {
    // 7b. Plain launch: one simulation.
    call = { functionName: "createLaunch", args: [params], value: state.nativeLaunchFee };
    try {
      const { result } = await client.simulateContract({
        address: factory,
        abi,
        functionName: "createLaunch",
        args: call.args,
        account: creator,
        value: call.value,
        stateOverride,
      });
      simulation = { token: result[0], poolId: result[1], amountOut: null, gas: 0n, gasSource: "fallback" };
    } catch (err) {
      const classified = classifyError(err);
      return failure("simulate", classified.kind, classified.message, classified);
    }
    if (getAddress(simulation.token) !== salt.token) {
      return failure("simulate", "token_check_failed", `factory would deploy ${simulation.token} but we predicted ${salt.token}`);
    }
  }

  // 8. Gas: live estimate with headroom, else a fallback from observed launches.
  try {
    const gas =
      call.functionName === "createLaunch"
        ? await client.estimateContractGas({ address: factory, abi, functionName: "createLaunch", args: call.args, account: creator, value: call.value, stateOverride })
        : await client.estimateContractGas({ address: factory, abi, functionName: "createLaunchAndBuy", args: call.args, account: creator, value: call.value, stateOverride });
    simulation = { ...simulation, gas: (gas * 120n) / 100n, gasSource: "estimate" };
  } catch (err) {
    logger.warn({ err: msg(err) }, "gas estimate failed; using fallback");
    simulation = { ...simulation, gas: GAS_FALLBACK[call.functionName], gasSource: "fallback" };
  }

  // 9. Funding check against the real balance (never the virtual one). The
  // fee cap is fixed here and the broadcast reuses it: a wallet client left
  // to estimate on its own asked for 2.4× the base fee once and the node
  // refused a launch the check had passed.
  let funding: LaunchPlan["funding"];
  try {
    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas = 0n;
    try {
      const fees = await client.estimateFeesPerGas();
      maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
      maxFeePerGas = fees.maxFeePerGas ?? (await client.getGasPrice());
    } catch {
      maxFeePerGas = await client.getGasPrice();
    }
    maxFeePerGas = (maxFeePerGas * FEE_CAP_PCT) / 100n;
    const gasWei = simulation.gas * maxFeePerGas;
    const balanceWei = await client.getBalance({ address: creator });
    const requiredWei = call.value + gasWei;
    funding = { valueWei: call.value, maxFeePerGas, maxPriorityFeePerGas, gasWei, requiredWei, balanceWei, shortfallWei: requiredWei > balanceWei ? requiredWei - balanceWei : 0n };
  } catch (err) {
    return failure("funding", "rpc_error", `funding check failed: ${msg(err)}`);
  }

  return {
    ok: true,
    plan: {
      chainId: chain.id,
      factory,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      state,
      quote,
      quoteState,
      bytecodeHash,
      salt,
      params,
      call,
      route,
      routeAttempts,
      simulation,
      funding,
    },
  };
}
