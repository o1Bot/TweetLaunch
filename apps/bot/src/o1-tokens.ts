import { getAddress, isAddress } from "viem";
import { env, logger } from "@o1bot/shared";
import type { TradableToken } from "./store";

/**
 * Tokens the bot did not launch, looked up on o1's Public API so a post can
 * trade any o1 Launchpad token. The API answers with the pool (hook, tick
 * spacing, quote) and market data; `trade-core` still verifies the pool on
 * chain before the allow-list opens it, so the API is a directory, not an
 * authority. Without O1_API_KEY the directory is empty and only tokens
 * launched through the bot can be traded.
 */

export type O1TokenSource = {
  /** Tokens whose symbol equals `ticker` (case-insensitive). */
  search(ticker: string): Promise<TradableToken[]>;
  byAddress(address: string): Promise<TradableToken | null>;
};

export const noO1Tokens: O1TokenSource = { search: async () => [], byAddress: async () => null };

type ApiToken = {
  chain_id?: number;
  token?: { address?: string; name?: string; symbol?: string; decimals?: number };
  launch?: {
    pool_id?: string;
    created_at?: string;
    quote?: { address?: string; symbol?: string; decimals?: number };
    contracts?: { hook_address?: string };
  };
  pool?: { hook_address?: string; tick_spacing?: number; pool_id?: string };
  market_data?: { liquidity?: { usd?: number | null } };
};

const CHAIN_ID = 4663;
const MAX_CANDIDATES = 5;

function toTradable(item: ApiToken): TradableToken | null {
  const address = item.token?.address;
  const quote = item.launch?.quote;
  const hook = item.pool?.hook_address ?? item.launch?.contracts?.hook_address;
  const tickSpacing = item.pool?.tick_spacing;
  const poolId = item.pool?.pool_id ?? item.launch?.pool_id;
  if (!address || !isAddress(address) || !quote?.address || !isAddress(quote.address) || !hook || !isAddress(hook) || typeof tickSpacing !== "number" || !poolId) return null;
  if (item.chain_id !== undefined && item.chain_id !== CHAIN_ID) return null;
  return {
    token: getAddress(address),
    symbol: item.token?.symbol ?? "",
    name: item.token?.name ?? item.token?.symbol ?? "",
    quoteAddress: getAddress(quote.address),
    quoteSymbol: quote.symbol ?? "",
    quoteDecimals: quote.decimals ?? 18,
    tickSpacing,
    hook: getAddress(hook),
    poolId,
    launchedAt: item.launch?.created_at ? new Date(item.launch.created_at) : new Date(0),
    source: "o1",
    liquidityUsd: typeof item.market_data?.liquidity?.usd === "number" ? item.market_data.liquidity.usd : null,
  };
}

export function liveO1Tokens(fetchImpl: typeof fetch = fetch): O1TokenSource {
  const e = env();
  const key = e.O1_API_KEY;
  const base = e.O1_API_URL.replace(/\/$/, "");
  if (!key) return noO1Tokens;

  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`o1 api ${path}: HTTP ${res.status}`);
    return ((await res.json()) as { data?: unknown }).data ?? null;
  };

  const detail = async (address: string): Promise<TradableToken | null> => {
    const data = (await get(`/tokens/${CHAIN_ID}/${address.toLowerCase()}?include=pool,market`)) as ApiToken | null;
    return data ? toTradable(data) : null;
  };

  return {
    async search(ticker) {
      const q = ticker.trim().replace(/^\$/, "");
      if (!q) return [];
      let items: ApiToken[];
      try {
        items = ((await get(`/tokens/search?chain_id=${CHAIN_ID}&q=${encodeURIComponent(q)}&limit=25`)) as ApiToken[] | null) ?? [];
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), ticker: q }, "o1 token search failed");
        return [];
      }
      const exact = items.filter((it) => (it.token?.symbol ?? "").toUpperCase() === q.toUpperCase() && it.token?.address).slice(0, MAX_CANDIDATES);
      const out: TradableToken[] = [];
      for (const it of exact) {
        try {
          const full = await detail(it.token!.address!);
          if (full) out.push(full);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err), token: it.token?.address }, "o1 token detail failed");
        }
      }
      return out;
    },
    async byAddress(address) {
      if (!isAddress(address)) return null;
      try {
        return await detail(address);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), token: address }, "o1 token detail failed");
        return null;
      }
    },
  };
}
