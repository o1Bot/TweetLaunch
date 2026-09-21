/**
 * One place for every number the venue shows. Two formatters drift: the market
 * list and the market page were already disagreeing about how many decimals a
 * $2,157 price gets, which reads as two different prices for the same market.
 */

/** Prices run from sub-cent memecoins to five-figure indices, so precision has
 *  to follow magnitude rather than be fixed. */
export function price(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v) || v <= 0) return "—";
  const decimals = v >= 1000 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 5 : 8;
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function changePct(n: number): { text: string; cls: string } {
  if (!Number.isFinite(n) || n === 0) return { text: "0.00%", cls: "muted" };
  return { text: `${n > 0 ? "+" : ""}${n.toFixed(2)}%`, cls: n > 0 ? "up" : "down" };
}

/**
 * maxLeverage() returns the exact ratio 10000/min_initial_margin_fraction, which
 * is what margin math needs but not a label: NEAR comes out 15.015015…x. Floor
 * it — rounding up would advertise more leverage than the venue allows.
 */
export function leverage(n: number | null): string {
  // A market with a zero margin fraction divides to Infinity; "Infinityx" is
  // not a leverage cap, and a trader reading it would believe something false.
  if (n === null || !Number.isFinite(n) || n < 1) return "—";
  return `${Math.floor(n)}x`;
}

/**
 * For ledger rows, where a zero is a fact rather than a gap. usd() prints "—"
 * for nothing, which reads as "unknown" — fine for a market's 24h volume, wrong
 * for a fee that is genuinely zero, since the whole point of the ledger is that
 * every line is known before the order goes in.
 */
export function usdExact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
