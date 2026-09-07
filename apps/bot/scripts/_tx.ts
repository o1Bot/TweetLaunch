import "@o1bot/shared/load-env";
import { erc20Abi, formatUnits, getAddress, parseEventLogs } from "viem";
import { db } from "@o1bot/db";
import { publicClient } from "@o1bot/shared";
const client = publicClient("robinhood");
const hash = "0xf4dc10dc81d9055d53943461acf93f60fc6bf17081f258c1d4efcdcef10dcf86";
const r = await client.getTransactionReceipt({ hash });
console.log("status", r.status, "block", r.blockNumber, "from", r.from);
for (const t of parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: r.logs })) {
  const pool = await db().pool.findUnique({ where: { token: getAddress(t.address) }, select: { symbol: true, name: true, launchSupply: true, token: true } });
  const supply = pool ? Number(pool.launchSupply.toString()) / 1e18 : null;
  const amount = Number(formatUnits(t.args.value, 18));
  console.log(`${pool?.symbol ?? t.address}: ${amount.toLocaleString("en-US")} from ${t.args.from} to ${t.args.to}${supply ? ` = ${((amount / supply) * 100).toFixed(2)}% of ${supply.toLocaleString("en-US")}` : ""}`);
  if (pool) {
    const dead = await client.readContract({ address: pool.token as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"] });
    console.log(`  dead address now holds ${Number(formatUnits(dead, 18)).toLocaleString("en-US")} ${pool.symbol} (${((Number(formatUnits(dead, 18)) / (supply ?? 1)) * 100).toFixed(2)}%)`);
  }
}
