/**
 * Deploy the FeeSplitterFactory on one chain from the values in .env:
 *
 *   pnpm contracts:deploy robinhood            # simulate only, prints what would be deployed
 *   pnpm contracts:deploy robinhood --broadcast
 *
 * Reads FEE_SPLITTER_DEPLOYER_KEY (gas payer), FEE_SPLITTER_TREASURY, FEE_SPLITTER_OWNER (defaults to the
 * deployer) and FEE_SPLITTER_PLATFORM_BPS; the o1 FeeEscrow comes from config/o1.json and the RPC from
 * RPC_<CHAIN> (or the public list). Runs `forge script script/Deploy.s.sol` and, after a broadcast, prints
 * the FEE_SPLITTER_FACTORY_<CHAIN> line to add to .env and the hosts.
 */
import "@o1bot/shared/load-env";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { activeFeeEscrow, chainByKey, env, isChainKey, rpcUrls } from "@o1bot/shared";

const args = process.argv.slice(2).filter((a) => a !== "--");
const key = args.find((a) => !a.startsWith("--")) ?? "";
const broadcast = args.includes("--broadcast");
if (!isChainKey(key)) {
  console.error("usage: pnpm contracts:deploy <robinhood|base|arc> [--broadcast]");
  process.exit(1);
}

const e = env();
const missing = (["FEE_SPLITTER_DEPLOYER_KEY", "FEE_SPLITTER_TREASURY"] as const).filter((k) => !e[k]);
if (missing.length) {
  console.error(`set ${missing.join(", ")} in .env first (see .env.example, "Fee splitter deployment")`);
  process.exit(1);
}
const deployer = privateKeyToAccount(e.FEE_SPLITTER_DEPLOYER_KEY as `0x${string}`);
const owner = e.FEE_SPLITTER_OWNER ?? deployer.address;
const escrow = activeFeeEscrow(key);
const rpc = rpcUrls(key)[0]!;
const chain = chainByKey(key);

console.log(`chain        ${chain.name} (${chain.id})`);
console.log(`rpc          ${rpc.replace(/(\/v2\/|\/v3\/)[^/]+/, "$1…")}`);
console.log(`o1 escrow    ${escrow}`);
console.log(`deployer     ${deployer.address}`);
console.log(`owner        ${owner}${e.FEE_SPLITTER_OWNER ? "" : " (defaults to the deployer; set FEE_SPLITTER_OWNER for a separate wallet)"}`);
console.log(`treasury     ${e.FEE_SPLITTER_TREASURY}`);
console.log(`platform     ${e.FEE_SPLITTER_PLATFORM_BPS} bps`);
console.log(broadcast ? "mode         BROADCAST (a real deployment)" : "mode         simulation only (add --broadcast to deploy)");

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", rpc, ...(broadcast ? ["--broadcast"] : []), "-vv"],
  {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      O1_FEE_ESCROW: escrow,
      TREASURY: e.FEE_SPLITTER_TREASURY!,
      OWNER: owner,
      PLATFORM_BPS: String(e.FEE_SPLITTER_PLATFORM_BPS),
      FEE_SPLITTER_DEPLOYER_KEY: e.FEE_SPLITTER_DEPLOYER_KEY!,
    },
  },
);
const out = result.stdout ?? "";
process.stdout.write(out);
if (result.status !== 0) {
  console.error(`forge script exited with ${result.status}`);
  process.exit(result.status ?? 1);
}
const factory = out.match(/FeeSplitterFactory\s+(0x[0-9a-fA-F]{40})/)?.[1];
if (factory && broadcast) {
  const varName = `FEE_SPLITTER_FACTORY_${key.toUpperCase()}`;
  console.log(`\ndeployed. Add to .env, then to Railway (bot) and Vercel (web):\n  ${varName}=${factory}`);
  console.log(`verify on the explorer with forge verify-contract if it offers verification; keep the owner key offline.`);
} else if (factory) {
  console.log(`\nsimulation ok; the factory would land at ${factory}. Re-run with --broadcast to deploy.`);
}
