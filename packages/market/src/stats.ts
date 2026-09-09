export type TokenStatsInput = {
  /** Latest trade price, quote per token (human units). Null before the first trade. */
  lastPrice: number | null;
  /** Last trade price at or before 24 hours ago; null when the token is younger than that. */
  priceAt24hAgo: number | null;
  /** Quote volume over the last 24 hours (human units). */
  volume24hQuote: number;
  /** Quote volume since launch (human units); defaults to the 24h figure when unknown. */
  volumeAllQuote?: number;
  /** Circulating supply in tokens (human units); launches place the full supply in the pool. */
  supplyTokens: number;
  /** USD price of one unit of the quote asset, or null when unknown. */
  quoteUsd: number | null;
  /** Launch price implied by the opening tick, used when there is no trade 24 hours ago. */
  launchPrice: number | null;
};

export type TokenStats = {
  priceQuote: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
  volume24hQuote: number;
  volume24hUsd: number | null;
  volumeAllQuote: number;
  volumeAllUsd: number | null;
  mcapQuote: number | null;
  mcapUsd: number | null;
};

export function computeStats(input: TokenStatsInput): TokenStats {
  const price = input.lastPrice;
  const reference = input.priceAt24hAgo ?? input.launchPrice;
  const change = price !== null && reference !== null && reference > 0 ? ((price - reference) / reference) * 100 : null;
  const usd = (q: number | null) => (q !== null && input.quoteUsd !== null ? q * input.quoteUsd : null);
  const mcapQuote = price !== null ? price * input.supplyTokens : null;
  const volumeAllQuote = Math.max(input.volumeAllQuote ?? input.volume24hQuote, input.volume24hQuote);
  return {
    priceQuote: price,
    priceUsd: usd(price),
    change24hPct: change,
    volume24hQuote: input.volume24hQuote,
    volume24hUsd: usd(input.volume24hQuote),
    volumeAllQuote,
    volumeAllUsd: usd(volumeAllQuote),
    mcapQuote,
    mcapUsd: usd(mcapQuote),
  };
}

/** Compact display helpers shared by the board and token page. */
export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

export function formatPrice(n: number | null, unit = ""): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const s = n >= 1 ? n.toFixed(4) : n >= 0.01 ? n.toFixed(5) : n >= 0.0001 ? n.toFixed(7) : n.toPrecision(3);
  return unit ? `${s} ${unit}` : s;
}

export function formatPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const r = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${n >= 0 ? "+" : ""}${r}%`;
}
