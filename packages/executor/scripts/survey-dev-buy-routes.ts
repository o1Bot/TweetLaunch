/**
 * How many stock tokens can receive an atomic dev buy from ETH right now?
 * Runs the bot's own route discovery for every registered stock and prints
 * the reachable set, the best candidate per stock and the ones without any
 * liquid route. No simulation, no signing.
 *
 *   pnpm --filter @o1bot/executor exec tsx scripts/survey-dev-buy-routes.ts
 */
import "@o1bot/shared/load-env";
import { publicClient, stockQuotes } from "@o1bot/shared";
import { discoverPrefixRoutes } from "../src/route-discovery";

async function main() {
  const client = publicClient("robinhood");
  const stocks = stockQuotes("robinhood");
  const reachable: string[] = [];
  const missing: string[] = [];
  for (const stock of stocks) {
    const candidates = await discoverPrefixRoutes(client, stock, { ttlMs: 0 });
    if (candidates.length === 0) {
      missing.push(stock.symbol);
      continue;
    }
    reachable.push(stock.symbol);
    console.log(`${stock.symbol.padEnd(8)} ${candidates.length} candidate(s); best: ${candidates[0]!.label}`);
  }
  console.log(`\nreachable: ${reachable.length} / ${stocks.length}`);
  console.log(`no route (${missing.length}): ${missing.join(", ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
