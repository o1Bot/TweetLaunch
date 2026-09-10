/**
 * Create the Privy policy that bounds o1bot's signer, so the allow-list is
 * enforced inside Privy's enclave and not only by signer.ts. Users attach
 * the policy when they grant the signer (addSigners with policyIds), after
 * which Privy refuses any request from the signer that the policy does not
 * allow, whatever the bot's server or its authorization key does.
 *
 * What the policy allows, and nothing else (Privy denies by default):
 *   - eth_signTransaction on Robinhood to the active o1 factory, calldata
 *     decoded as createLaunch, createLaunchAndBuy or setCreatorFeeRecipient,
 *     value at most creation fee + MAX_DEV_BUY_ETH, and the app-wide value
 *     signed in the last 24 hours below --daily-cap (a stateful aggregation).
 *   - eth_signTransaction on Robinhood to the fee escrow, calldata decoded as
 *     claimFor or claimTo, value 0.
 *   - Trades from a post: execute on the Universal Router with value at most
 *     MAX_TRADE_ETH, an ERC-20 approve naming Permit2 as spender (value 0),
 *     and a Permit2 approve naming the router as spender (value 0). The
 *     signer allow-list still decodes the router call and pins the pool, the
 *     referral and the recipient; the policy bounds the value.
 *   - Bridging from a post: depositNative on Relay's pinned depository on
 *     Base, Ethereum, Arbitrum or Optimism, value at most MAX_BRIDGE_ETH,
 *     with the depositor argument pinned to the zero address, which the
 *     depository resolves to msg.sender: the deposit can only be credited
 *     to the signing wallet, whatever the calldata's author intended.
 *   Message, typed-data, EIP-7702, raw and export requests fall through to
 *   the default DENY.
 *
 * The policy and the aggregation are owned by a separate P-256 key quorum
 * created here, so the app secret and the bot's signing key cannot edit
 * them. Its private key is written to notes/privy-policy-owner.key (git
 * ignored); move it somewhere offline and delete the file.
 *
 *   pnpm privy:policy                     # create owner key, aggregation and policy; write the ids to .env
 *   pnpm privy:policy --owner <quorumId>  # reuse an existing owner key quorum instead of creating one
 *   pnpm privy:policy --aggregation <id>  # reuse the existing 24h aggregation (apps get at most 10)
 *   pnpm privy:policy --daily-cap 25      # rolling 24h cap on signed value across all wallets, in ETH (default 25)
 *   pnpm privy:policy --force             # replace PRIVY_POLICY_ID (users must grant the signer again)
 */
import "@o1bot/shared/load-env";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseEther } from "viem";
import { findRepoRoot } from "@o1bot/shared/load-env";
import { activeFactory, activeFeeEscrow, BRIDGE_CHAIN_KEYS, bridgeChainByKey, chainByKey, env, o1Chain, RELAY_DEPOSITORY, requireEnv } from "@o1bot/shared";
import { baseFeeEscrowAbi, baseLaunchFactoryAbi, feeEscrowAbi, launchFactoryAbi } from "@o1bot/executor";
import { permit2Abi, universalRouterAbi } from "@o1bot/swap";

const VARS = ["PRIVY_POLICY_ID", "NEXT_PUBLIC_PRIVY_POLICY_ID"] as const;
const LAUNCH_FUNCTIONS = ["createLaunch", "createLaunchAndBuy", "setCreatorFeeRecipient"];
const CLAIM_FUNCTIONS = ["claimFor", "claimTo"];
const API = "https://api.privy.io/v1";

type AbiEntry = { type?: string; name?: string };

function abiFunctions(abi: readonly unknown[], names: string[]): unknown[] {
  const picked = (abi as AbiEntry[]).filter((e) => e.type === "function" && names.includes(e.name ?? ""));
  const missing = names.filter((n) => !picked.some((e) => (e as AbiEntry).name === n));
  if (missing.length) throw new Error(`vendored ABI lacks ${missing.join(", ")}`);
  return picked;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function privyPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: {
      "privy-app-id": appId,
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Privy ${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main() {
  const force = process.argv.includes("--force");
  const root = findRepoRoot();
  if (!root) throw new Error("repository root not found");
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) throw new Error(".env not found at the repository root");
  const current = readFileSync(envPath, "utf8");
  const already = VARS.filter((k) => new RegExp(`^${k}=.+$`, "m").test(current));
  if (already.length && !force) {
    throw new Error(`${already.join(", ")} already set in .env; pass --force to replace them (users will have to grant the signer again)`);
  }

  const key = "robinhood" as const;
  const chainId = String(chainByKey(key).id);
  const factory = activeFactory(key);
  const escrow = activeFeeEscrow(key);
  const creationFeeWei = BigInt(o1Chain(key).snapshot.nativeLaunchFeeRaw);
  const perTxCapWei = creationFeeWei + parseEther(env().MAX_DEV_BUY_ETH);
  const tradeCapWei = parseEther(env().MAX_TRADE_ETH);
  const bridgeCapWei = parseEther(env().MAX_BRIDGE_ETH);
  const originChainIds = BRIDGE_CHAIN_KEYS.map((k) => String(bridgeChainByKey(k).id));
  const depositAbi = [{ type: "function", name: "depositNative", stateMutability: "payable", inputs: [{ name: "to", type: "address" }, { name: "id", type: "bytes32" }], outputs: [] }];
  const dailyCapWei = parseEther(argValue("--daily-cap") ?? "25");
  const router = o1Chain(key).uniswapV4.universalRouter;
  const permit2 = o1Chain(key).uniswapV4.permit2;
  const erc20ApproveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }];

  // 1. Owner key quorum: the only party that can edit the policy afterwards.
  let ownerId = argValue("--owner");
  let ownerKeyPath: string | null = null;
  if (!ownerId) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const privateDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    const quorum = await privyPost("key_quorums", { display_name: "o1bot policy owner", public_keys: [publicDer], authorization_threshold: 1 });
    ownerId = String(quorum.id ?? "");
    if (!ownerId) throw new Error("Privy returned no key quorum id for the policy owner");
    mkdirSync(join(root, "notes"), { recursive: true });
    ownerKeyPath = join(root, "notes", "privy-policy-owner.key");
    writeFileSync(ownerKeyPath, `# Privy key quorum ${ownerId} (owner of the o1bot signer policy). Keep offline, never in any env.\nwallet-auth:${privateDer}\n`);
  }

  const tx = (field: "chain_id" | "to" | "value", operator: "eq" | "lte", value: string) => ({ field_source: "ethereum_transaction", field, operator, value });
  // Base (2026-09-11): launches and fee claims only. Router and Permit2 rules for Base arrive with trades on Base.
  const base = {
    chainId: String(chainByKey("base").id),
    factory: activeFactory("base"),
    escrow: activeFeeEscrow("base"),
    router: o1Chain("base").uniswapV4.universalRouter,
    permit2: o1Chain("base").uniswapV4.permit2,
    perTxCapWei: BigInt(o1Chain("base").snapshot.nativeLaunchFeeRaw) + parseEther(env().MAX_DEV_BUY_ETH),
  };

  // 2. Aggregation: value signed by the signer over a rolling day, across all wallets and chains.
  let aggregationId = argValue("--aggregation");
  if (!aggregationId) {
    const aggregation = await privyPost("aggregations", {
      name: "o1bot signer: value signed per rolling 24h",
      method: "eth_signTransaction",
      metric: { field_source: "ethereum_transaction", field: "value", function: "sum" },
      window: { type: "rolling", seconds: 86_400 },
      conditions: [],
      owner_id: ownerId,
    });
    aggregationId = String(aggregation.id ?? "");
    if (!aggregationId) throw new Error("Privy returned no aggregation id");
  }

  // 3. The policy itself.
  const policyBody = {
    version: "1.0",
    name: "o1bot signer",
    chain_type: "ethereum",
    owner_id: ownerId,
    rules: [
      {
        name: "Launch, dev buy or fee recipient on the o1 factory",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", chainId),
          tx("to", "eq", factory),
          tx("value", "lte", perTxCapWei.toString()),
          { field_source: "ethereum_calldata", field: "function_name", abi: abiFunctions(launchFactoryAbi, LAUNCH_FUNCTIONS), operator: "in", value: LAUNCH_FUNCTIONS },
          { field_source: "reference", field: `aggregation.${aggregationId}`, operator: "lte", value: dailyCapWei.toString() },
        ],
      },
      {
        name: "Fee claims on the o1 escrow",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", chainId),
          tx("to", "eq", escrow),
          tx("value", "eq", "0"),
          { field_source: "ethereum_calldata", field: "function_name", abi: abiFunctions(feeEscrowAbi, CLAIM_FUNCTIONS), operator: "in", value: CLAIM_FUNCTIONS },
        ],
      },
      {
        name: "Router swap (trade from a post)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", chainId),
          tx("to", "eq", router),
          tx("value", "lte", tradeCapWei.toString()),
          { field_source: "ethereum_calldata", field: "function_name", abi: universalRouterAbi, operator: "eq", value: "execute" },
          { field_source: "reference", field: `aggregation.${aggregationId}`, operator: "lte", value: dailyCapWei.toString() },
        ],
      },
      {
        name: "Token approval to Permit2 (sell)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", chainId),
          tx("value", "eq", "0"),
          { field_source: "ethereum_calldata", field: "approve.spender", abi: erc20ApproveAbi, operator: "eq", value: permit2 },
        ],
      },
      {
        name: "Relay bridge deposit (from a post)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "chain_id", operator: "in", value: originChainIds },
          tx("to", "eq", RELAY_DEPOSITORY),
          tx("value", "lte", bridgeCapWei.toString()),
          { field_source: "ethereum_calldata", field: "function_name", abi: depositAbi, operator: "eq", value: "depositNative" },
          { field_source: "ethereum_calldata", field: "depositNative.to", abi: depositAbi, operator: "eq", value: "0x0000000000000000000000000000000000000000" },
          { field_source: "reference", field: `aggregation.${aggregationId}`, operator: "lte", value: dailyCapWei.toString() },
        ],
      },
      {
        name: "Permit2 approval to router (sell)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", chainId),
          tx("to", "eq", permit2),
          tx("value", "eq", "0"),
          { field_source: "ethereum_calldata", field: "approve.spender", abi: abiFunctions(permit2Abi as unknown as readonly unknown[], ["approve"]), operator: "eq", value: router },
        ],
      },
      {
        name: "Launch, dev buy or fee recipient on o1 Base",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", base.chainId),
          tx("to", "eq", base.factory),
          tx("value", "lte", base.perTxCapWei.toString()),
          { field_source: "ethereum_calldata", field: "function_name", abi: abiFunctions(baseLaunchFactoryAbi, LAUNCH_FUNCTIONS), operator: "in", value: LAUNCH_FUNCTIONS },
          { field_source: "reference", field: `aggregation.${aggregationId}`, operator: "lte", value: dailyCapWei.toString() },
        ],
      },
      {
        name: "Fee claims on the o1 Base escrow",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", base.chainId),
          tx("to", "eq", base.escrow),
          tx("value", "eq", "0"),
          { field_source: "ethereum_calldata", field: "function_name", abi: abiFunctions(baseFeeEscrowAbi, CLAIM_FUNCTIONS), operator: "in", value: CLAIM_FUNCTIONS },
        ],
      },
      // Router and Permit2 on Base: the code allow-list only admits them once trades run on Base,
      // but having the enclave rules now spares users another re-grant then.
      {
        name: "Router swap on Base (trade from a post)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", base.chainId),
          tx("to", "eq", base.router),
          tx("value", "lte", tradeCapWei.toString()),
          { field_source: "ethereum_calldata", field: "function_name", abi: universalRouterAbi, operator: "eq", value: "execute" },
          { field_source: "reference", field: `aggregation.${aggregationId}`, operator: "lte", value: dailyCapWei.toString() },
        ],
      },
      {
        name: "Token approval to Permit2 on Base (sell)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", base.chainId),
          tx("value", "eq", "0"),
          { field_source: "ethereum_calldata", field: "approve.spender", abi: erc20ApproveAbi, operator: "eq", value: base.permit2 },
        ],
      },
      {
        name: "Permit2 approval to router on Base (sell)",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          tx("chain_id", "eq", base.chainId),
          tx("to", "eq", base.permit2),
          tx("value", "eq", "0"),
          { field_source: "ethereum_calldata", field: "approve.spender", abi: abiFunctions(permit2Abi as unknown as readonly unknown[], ["approve"]), operator: "eq", value: base.router },
        ],
      },
    ],
  };
  const policy = await privyPost("policies", policyBody);
  const policyId = String(policy.id ?? "");
  if (!policyId) throw new Error("Privy returned no policy id");

  // 4. Record: ids into .env, the full document into notes/ for review and for sharing.
  let next = current;
  for (const k of VARS) {
    const line = `${k}=${policyId}`;
    next = new RegExp(`^${k}=.*$`, "m").test(next) ? next.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${next.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(envPath, next);
  mkdirSync(join(root, "notes"), { recursive: true });
  const docPath = join(root, "notes", "privy-policy.json");
  writeFileSync(docPath, `${JSON.stringify({ policy_id: policyId, aggregation_id: aggregationId, owner_key_quorum_id: ownerId, request: policyBody }, null, 2)}\n`);

  console.log(`policy created: ${policyId} (owner key quorum ${ownerId}, aggregation ${aggregationId})`);
  console.log(`per-transaction cap ${formatEther(perTxCapWei)} ETH (launch), ${formatEther(tradeCapWei)} ETH (trade), ${formatEther(bridgeCapWei)} ETH (bridge deposit), rolling 24h cap ${formatEther(dailyCapWei)} ETH across all wallets and chains`);
  console.log(`written to .env: ${VARS.join(", ")}; policy document in ${docPath}`);
  if (ownerKeyPath) console.log(`owner private key written to ${ownerKeyPath}: move it offline and delete the file`);
  console.log("next: pnpm env:split, update PRIVY_POLICY_ID on Railway and NEXT_PUBLIC_PRIVY_POLICY_ID on Vercel, redeploy both; existing users are asked to grant the signer again on their next visit");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
