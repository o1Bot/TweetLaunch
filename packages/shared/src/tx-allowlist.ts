import { decodeFunctionData, getAddress, isAddress, parseAbi, toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { decodeExactInputSwap, decodeHookData, launchPoolKey, SWAP_COMMENT } from "@o1bot/swap";

/**
 * The bot signs ONLY these transaction kinds, and only to known contracts:
 * o1's factory and fee escrow, and for trades from a post the Universal
 * Router, Permit2 and the token being sold. Anything else is refused
 * before it reaches Privy. A post can never turn into arbitrary calldata:
 * every call is decoded against the allowed function and its arguments are
 * checked, and a router call is accepted only when it is exactly one
 * exact-input swap on an o1 launch pool the bot knows, paying the signer.
 */
export const ALLOWED_TX_KINDS = [
  "createLaunch",
  "createLaunchAndBuy",
  "erc20Approve",
  "setCreatorFeeRecipient",
  "feeClaimFor",
  "feeClaimTo",
  "permit2Approve",
  "routerExecute",
  "relayDeposit",
] as const;
export type AllowedTxKind = (typeof ALLOWED_TX_KINDS)[number];

/**
 * Function signatures per o1's "Functions and events" and "Direct contract
 * integration" pages (fetched 2026-09-06), Permit2 and the Universal
 * Router. The launch tuple layout is the documented `LaunchParams`; step 2
 * re-derives these selectors from the verified explorer ABI vendored under
 * `abis/`. If a signature here is wrong the guard fails closed (rejects);
 * it never lets something else through.
 */
const LAUNCH_PARAMS = "(string,string,string,bytes32,address,uint64,uint64,bool,string[],string[])";
const LAUNCH_BUY_PARAMS = "(address,uint256,uint256,bytes)";

export const TX_SIGNATURES: Record<AllowedTxKind, string> = {
  createLaunch: `createLaunch(${LAUNCH_PARAMS})`,
  createLaunchAndBuy: `createLaunchAndBuy(${LAUNCH_PARAMS},${LAUNCH_BUY_PARAMS})`,
  erc20Approve: "approve(address,uint256)",
  setCreatorFeeRecipient: "setCreatorFeeRecipient(address,address)",
  feeClaimFor: "claimFor(address,address)",
  feeClaimTo: "claimTo(address,address)",
  permit2Approve: "approve(address,address,uint160,uint48)",
  routerExecute: "execute(bytes,bytes[],uint256)",
  relayDeposit: "depositNative(address,bytes32)",
};

export const TX_SELECTORS: Record<AllowedTxKind, Hex> = Object.fromEntries(
  ALLOWED_TX_KINDS.map((kind) => [kind, toFunctionSelector(TX_SIGNATURES[kind])]),
) as Record<AllowedTxKind, Hex>;

/** Full ABI of the allowed surface, so calldata is decoded, not just selector-matched. */
const TX_ABI = parseAbi(ALLOWED_TX_KINDS.map((kind) => `function ${TX_SIGNATURES[kind]}`));

/** An o1 launch pool the bot may trade on: the exact pool key is rebuilt from these. */
export type TradablePool = { token: Address; quote: Address; tickSpacing: number };

export type SwapRules = {
  hook: Address;
  /** Referrer the hook data must carry; null = hook data must be empty. */
  referrer: Address | null;
  /** Largest native value (a buy's ETH input) a router call may carry. */
  maxValueWei: bigint;
  pools: TradablePool[];
};

export type AllowlistEntry = {
  kind: AllowedTxKind;
  to: Address;
  /** For `erc20Approve` and `permit2Approve`: the only spenders an approval may name. */
  spenders?: Address[];
  /** For `permit2Approve`: the only tokens the approval may cover. */
  tokens?: Address[];
  /** For `routerExecute`: what the swap must look like. */
  swap?: SwapRules;
  /** For `relayDeposit`: the one deposit the quote described. */
  bridge?: { wallet: Address; depositId: Hex; amountWei: bigint };
};
export type TxAllowlist = { chainId: number; entries: AllowlistEntry[] };

export type TradeAllowance = {
  router: Address;
  permit2: Address;
  hook: Address;
  referrer: Address | null;
  maxValueWei: bigint;
  pools: TradablePool[];
};

export function buildAllowlist(input: {
  chainId: number;
  factory: Address;
  feeEscrow: Address;
  /** ERC-20 quote tokens an approval may target (never native). */
  approvalTargets?: Address[];
  /** Contracts an approval may name as spender; the factory alone by default. */
  approvalSpenders?: Address[];
  /** Present only while executing a trade from a post. */
  trade?: TradeAllowance;
}): TxAllowlist {
  const entries: AllowlistEntry[] = [
    { kind: "createLaunch", to: getAddress(input.factory) },
    { kind: "createLaunchAndBuy", to: getAddress(input.factory) },
    { kind: "setCreatorFeeRecipient", to: getAddress(input.factory) },
    { kind: "feeClaimFor", to: getAddress(input.feeEscrow) },
    { kind: "feeClaimTo", to: getAddress(input.feeEscrow) },
  ];
  const spenders = (input.approvalSpenders ?? [input.factory]).map((a) => getAddress(a));
  for (const token of input.approvalTargets ?? []) {
    entries.push({ kind: "erc20Approve", to: getAddress(token), spenders });
  }
  if (input.trade) {
    const t = input.trade;
    const pools = t.pools.map((p) => ({ token: getAddress(p.token), quote: getAddress(p.quote), tickSpacing: p.tickSpacing }));
    // The router pulls the token on a sell and the quote asset on a stock or USDG buy; both may need approvals.
    const assets = [...new Set([...pools.map((p) => p.token), ...pools.map((p) => p.quote).filter((q) => q !== zeroAddress)])];
    entries.push({ kind: "routerExecute", to: getAddress(t.router), swap: { hook: getAddress(t.hook), referrer: t.referrer ? getAddress(t.referrer) : null, maxValueWei: t.maxValueWei, pools } });
    entries.push({ kind: "permit2Approve", to: getAddress(t.permit2), spenders: [getAddress(t.router)], tokens: assets });
    for (const asset of assets) entries.push({ kind: "erc20Approve", to: asset, spenders: [getAddress(t.permit2)] });
  }
  return { chainId: input.chainId, entries };
}

/**
 * The allow-list for one bridge deposit on an origin chain: Relay's pinned
 * depository, `depositNative(0x0, depositId)` for this quote, carrying
 * exactly the quoted value. The zero depositor makes the contract credit
 * msg.sender, the signing wallet, so no calldata field can redirect the
 * deposit; the enclave policy pins the same zero. Nothing else on that chain.
 */
export function buildBridgeAllowlist(input: { chainId: number; depository: Address; wallet: Address; depositId: Hex; amountWei: bigint }): TxAllowlist {
  return {
    chainId: input.chainId,
    entries: [{ kind: "relayDeposit", to: getAddress(input.depository), bridge: { wallet: getAddress(input.wallet), depositId: input.depositId.toLowerCase() as Hex, amountWei: input.amountWei } }],
  };
}

export type TxCheck = { ok: true; kind: AllowedTxKind; selector: Hex } | { ok: false; reason: string };

export type TxLike = {
  chainId?: number | undefined;
  to?: Address | string | null | undefined;
  data?: Hex | string | undefined;
  value?: bigint | undefined;
};

/** Kinds whose native value the plan sets and verifies against the balance; every other call must carry none. */
const VALUE_BEARING: ReadonlySet<AllowedTxKind> = new Set(["createLaunch", "createLaunchAndBuy", "routerExecute", "relayDeposit"]);

function checkSwap(entry: AllowlistEntry, data: Hex, value: bigint): TxCheck {
  const rules = entry.swap;
  if (!rules) return { ok: false, reason: "router entry without swap rules" };
  const swap = decodeExactInputSwap(data);
  if (!swap) return { ok: false, reason: "router call is not exactly one exact-input v4 swap paying the sender" };
  if (swap.poolKey.hooks !== rules.hook || swap.poolKey.fee !== 0) return { ok: false, reason: "swap is not on an o1 launch pool" };
  const pool = rules.pools.find((p) => {
    const key = launchPoolKey(p.token, p.quote, p.tickSpacing, rules.hook);
    return key.currency0 === swap.poolKey.currency0 && key.currency1 === swap.poolKey.currency1 && key.tickSpacing === swap.poolKey.tickSpacing;
  });
  if (!pool) return { ok: false, reason: "swap pool is not one the bot may trade" };
  const hook = decodeHookData(swap.hookData);
  if (!hook) return { ok: false, reason: "hook data is malformed" };
  if (hook.referrer !== rules.referrer || (rules.referrer && hook.comment !== SWAP_COMMENT)) return { ok: false, reason: "hook data does not carry o1bot's referral" };
  if (value !== swap.value) return { ok: false, reason: `native value ${value} does not match the swap input ${swap.value}` };
  if (swap.value > rules.maxValueWei) return { ok: false, reason: `swap value ${swap.value} exceeds the cap ${rules.maxValueWei}` };
  if (swap.amountIn === 0n) return { ok: false, reason: "swap input is zero" };
  return { ok: true, kind: entry.kind, selector: TX_SELECTORS[entry.kind] };
}

export function checkTransaction(allowlist: TxAllowlist, tx: TxLike): TxCheck {
  if (tx.chainId === undefined) return { ok: false, reason: "transaction has no chainId" };
  if (tx.chainId !== allowlist.chainId) {
    return { ok: false, reason: `chainId ${tx.chainId} is not the allow-listed chain ${allowlist.chainId}` };
  }
  if (!tx.to) return { ok: false, reason: "contract creation is not allowed" };
  if (!isAddress(tx.to)) return { ok: false, reason: "malformed to-address" };
  const to = getAddress(tx.to);
  const data = (tx.data ?? "0x") as string;
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) {
    return { ok: false, reason: "plain value transfers and calls without a selector are not allowed" };
  }
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const entry = allowlist.entries.find((e) => e.to === to && TX_SELECTORS[e.kind] === selector);
  if (!entry) return { ok: false, reason: `selector ${selector} to ${to} is not allow-listed` };
  const value = tx.value ?? 0n;
  if (!VALUE_BEARING.has(entry.kind) && value !== 0n) return { ok: false, reason: `${entry.kind} must not carry native value` };

  // The selector says which function; the arguments must decode as that
  // function too, so truncated or padded calldata never gets a signature.
  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: TX_ABI, data: data as Hex });
    args = decoded.args ?? [];
  } catch {
    return { ok: false, reason: `calldata does not decode as ${TX_SIGNATURES[entry.kind]}` };
  }

  // An approval is only ever for the contract that will pull the tokens.
  if (entry.kind === "erc20Approve") {
    const spender = args[0];
    if (typeof spender !== "string" || !isAddress(spender)) return { ok: false, reason: "approve spender is not an address" };
    if (!(entry.spenders ?? []).includes(getAddress(spender))) {
      return { ok: false, reason: `approve spender ${getAddress(spender)} is not allow-listed` };
    }
  }
  if (entry.kind === "permit2Approve") {
    const [token, spender] = args;
    if (typeof token !== "string" || !isAddress(token) || typeof spender !== "string" || !isAddress(spender)) return { ok: false, reason: "permit2 approve arguments are not addresses" };
    if (!(entry.tokens ?? []).includes(getAddress(token))) return { ok: false, reason: `permit2 approve token ${getAddress(token)} is not allow-listed` };
    if (!(entry.spenders ?? []).includes(getAddress(spender))) return { ok: false, reason: `permit2 approve spender ${getAddress(spender)} is not allow-listed` };
  }
  if (entry.kind === "routerExecute") return checkSwap(entry, data as Hex, value);
  if (entry.kind === "relayDeposit") {
    const rules = entry.bridge;
    if (!rules) return { ok: false, reason: "deposit entry without bridge rules" };
    const [depositor, id] = args;
    if (typeof depositor !== "string" || !isAddress(depositor) || getAddress(depositor) !== zeroAddress) return { ok: false, reason: "deposit must leave the depositor empty so the contract credits the signing wallet" };
    if (typeof id !== "string" || id.toLowerCase() !== rules.depositId) return { ok: false, reason: "deposit id is not the quoted one" };
    if (value !== rules.amountWei) return { ok: false, reason: `deposit value ${value} is not the quoted ${rules.amountWei}` };
  }
  return { ok: true, kind: entry.kind, selector };
}
