/**
 * Which hook-free V4 (fee, tickSpacing) tiers actually hold liquidity for
 * USDG/stock and WETH/stock pairs on Robinhood Chain? Probes StateView over
 * the discovery grid (V4_FEES × V4_TICK_SPACINGS) for every registered stock
 * token and prints the tiers found, so the grid in src/v4.ts stays honest.
 *
 *   pnpm --filter @o1bot/executor exec tsx scripts/survey-v4-tiers.ts
 */
import "@o1bot/shared/load-env";
import { getAddress, isAddress, type Address } from "viem";
import { findQuote, o1Chain, publicClient, stockQuotes } from "@o1bot/shared";
import { poolIdOf, poolKeyFor, stateViewAbi, V4_FEES, V4_TICK_SPACINGS } from "../src/v4";

const FEES = V4_FEES;
const SPACINGS = V4_TICK_SPACINGS;

async function main() {
  const client = publicClient("robinhood");
  const chain = o1Chain("robinhood");
  const stateView = chain.uniswapV4.stateView;
  const usdg = findQuote("robinhood", "USDG")!.address;
  const weth = chain.swapX.wrappedNativeToken;
  if (typeof weth !== "string" || !isAddress(weth)) throw new Error("no WETH in config");
  const stocks = stockQuotes("robinhood");
  const grid = FEES.flatMap((fee) => SPACINGS.map((tickSpacing) => [fee, tickSpacing] as const));
  console.log(`${stocks.length} stocks × ${grid.length} tiers × 2 bases`);

  const tierHits = new Map<string, number>();
  const reachable = new Set<string>();
  const perStock: Array<{ symbol: string; pools: string[] }> = [];

  for (const stock of stocks) {
    const bases: Array<[string, Address]> = [
      ["USDG", usdg],
      ["WETH", getAddress(weth)],
    ];
    const pools: string[] = [];
    for (const [baseName, base] of bases) {
      const results = await client.multicall({
        allowFailure: true,
        contracts: grid.map(([fee, tickSpacing]) => ({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolIdOf(poolKeyFor(base, stock.address, fee, tickSpacing))] }) as const),
      });
      results.forEach((r, i) => {
        if (r.status === "success" && r.result > 0n) {
          const [fee, tickSpacing] = grid[i]!;
          const key = `${baseName} ${fee}/${tickSpacing}`;
          tierHits.set(key, (tierHits.get(key) ?? 0) + 1);
          pools.push(`${key} liq=${r.result.toString()}`);
          if (baseName === "USDG") reachable.add(stock.symbol);
        }
      });
    }
    perStock.push({ symbol: stock.symbol, pools });
  }

  console.log("\nTiers with liquidity (base fee/tickSpacing → number of stocks):");
  for (const [key, n] of [...tierHits.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${key.padEnd(18)} ${n}`);
  console.log(`\nStocks with at least one hook-free V4 USDG pool: ${reachable.size} / ${stocks.length}`);
  console.log("Stocks with no V4 pool at all:", perStock.filter((s) => s.pools.length === 0).map((s) => s.symbol).join(", ") || "(none)");
  console.log("\nPer stock:");
  for (const s of perStock) if (s.pools.length) console.log(`  ${s.symbol.padEnd(8)} ${s.pools.join(" | ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
