/**
 * Dry-run a launch end to end WITHOUT signing or broadcasting:
 *
 *   pnpm simulate --name "Rugrat" --symbol RUGRAT [--pair ETH] [--devbuy 0.01] [--chain base|arc]
 *                 [--creator 0x…] [--uri ipfs://…] [--editable] [--skip-drift-check] [--no-fund]
 *
 * With no --creator a random address is used and, unless --no-fund, given a
 * virtual balance via eth_call state override so the simulation runs on an
 * empty wallet. The funding section always reports the REAL balance.
 */
import "@o1bot/shared/load-env";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatEther, getAddress, parseEther, toHex, type Hex } from "viem";
import { isChainKey, type ChainKey } from "@o1bot/shared";
import { planLaunch } from "../src/index";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // no .env: public RPC fallbacks are used
}

const { values } = parseArgs({
  // pnpm forwards a literal "--" ahead of user flags; parseArgs would treat everything after it as positional.
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
  options: {
    name: { type: "string" },
    symbol: { type: "string" },
    pair: { type: "string", default: "ETH" },
    chain: { type: "string", default: "robinhood" },
    creator: { type: "string" },
    devbuy: { type: "string" },
    uri: { type: "string", default: "ipfs://placeholder-not-pinned" },
    editable: { type: "boolean", default: false },
    "skip-drift-check": { type: "boolean", default: false },
    "no-fund": { type: "boolean", default: false },
    seed: { type: "string" },
  },
});

if (!values.name || !values.symbol) {
  console.error('usage: pnpm simulate --name "Token name" --symbol TICKER [--pair ETH] [--devbuy 0.01] [--creator 0x…] [--chain robinhood|base|arc]');
  process.exit(2);
}

const creator = getAddress(values.creator ?? toHex(randomBytes(20)));
const started = Date.now();
const result = await planLaunch(
  {
    creator,
    chain: isChainKey(values.chain ?? "") ? (values.chain as ChainKey) : "robinhood",
    name: values.name,
    symbol: values.symbol,
    pair: values.pair,
    tokenContractURI: values.uri,
    devBuyWei: values.devbuy ? parseEther(values.devbuy) : undefined,
    metadataEditable: values.editable,
  },
  {
    skipDriftCheck: values["skip-drift-check"],
    fundSimulation: !values["no-fund"],
    saltSeed: values.seed as Hex | undefined,
  },
);
const elapsed = Date.now() - started;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

if (!result.ok) {
  console.error(`PLAN FAILED at stage "${result.stage}" after ${elapsed} ms`);
  console.error(json(result.error));
  for (const a of result.routeAttempts ?? []) console.error(`  route ${a.label} (${a.hops} hops): ${a.error ? `${a.error.errorName ?? a.error.kind}` : `out ${a.amountOut}`}`);
  process.exit(1);
}

const { plan } = result;
console.log(`PLAN OK in ${elapsed} ms (no transaction was sent)`);
console.log(`  chain         ${plan.chainId} @ block ${plan.blockNumber}`);
console.log(`  factory       ${plan.factory} (configVersion ${plan.state.configVersion})`);
console.log(`  creator       ${creator}`);
console.log(`  pair          ${plan.quote.symbol} ${plan.quote.address} (${plan.quote.kind}, revision ${plan.quoteState.revision})`);
console.log(`  token         ${plan.salt.token}  (salt mined in ${plan.salt.attempts} attempts)`);
console.log(`  poolId        ${plan.simulation.poolId}`);
console.log(`  call          ${plan.call.functionName}  value ${formatEther(plan.call.value)} ETH`);
if (plan.simulation.amountOut !== null && plan.call.functionName === "createLaunchAndBuy") {
  console.log(`  dev buy       ${formatEther(plan.call.args[1].amountIn)} ETH → ${formatEther(plan.simulation.amountOut)} tokens (minAmountOut ${formatEther(plan.call.args[1].minAmountOut)})`);
  console.log(`  route         ${plan.route?.label} (${plan.route?.steps.length} hops, ${(plan.call.args[1].routeData.length - 2) / 2} bytes)`);
  for (const a of plan.routeAttempts) console.log(`    candidate   ${a.label}: ${a.error ? `revert ${a.error.errorName ?? a.error.kind}` : `${formatEther(a.amountOut ?? 0n)} tokens`}`);
}
console.log(`  gas           ${plan.simulation.gas} (${plan.simulation.gasSource}) @ ${plan.funding.maxFeePerGas} wei/gas = ${formatEther(plan.funding.gasWei)} ETH`);
console.log(`  required      ${formatEther(plan.funding.requiredWei)} ETH`);
console.log(`  balance       ${formatEther(plan.funding.balanceWei)} ETH  shortfall ${formatEther(plan.funding.shortfallWei)} ETH`);
console.log(`  deadline      ${new Date(Number(plan.params.deadline) * 1000).toISOString()}`);
console.log("\nlaunch params:");
console.log(json(plan.params));
