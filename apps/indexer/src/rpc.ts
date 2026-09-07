import type { Address, Hash, PublicClient } from "viem";

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** blockNumber → unix seconds. getLogs results carry no timestamp. */
export async function blockTimestamps(client: PublicClient, blocks: bigint[]): Promise<Map<bigint, number>> {
  const uniq = [...new Set(blocks)];
  const stamps = await mapLimit(uniq, 8, async (n) => Number((await client.getBlock({ blockNumber: n })).timestamp));
  return new Map(uniq.map((n, i) => [n, stamps[i] as number]));
}

/** txHash → sender wallet. A swap's on-chain `sender` is the router, not the trader. */
export async function txSenders(client: PublicClient, hashes: Hash[]): Promise<Map<Hash, Address>> {
  const uniq = [...new Set(hashes)];
  const froms = await mapLimit(uniq, 8, async (h) => (await client.getTransaction({ hash: h })).from);
  return new Map(uniq.map((h, i) => [h, froms[i] as Address]));
}
