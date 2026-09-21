/**
 * Crypto or real-world asset, for the dot beside a symbol and the rail filter.
 *
 * The venue publishes no category field. `trading_hours` is empty on all 235
 * perp markets and `insurance_fund_account_index` splits by risk tier, not by
 * asset class — it puts ASML with BTC and CASHCAT with AAPL. What does separate
 * them is `funding_premium_multiplier`, checked on 2026-09-21 against symbols
 * whose class is not in doubt:
 *
 *   100 — every one of 17 known crypto markets (BTC, ETH, SOL, DOGE, XRP, …)
 *    50 — 20 of 23 known RWA markets (AAPL, XAU, WTI, EURUSD, US500, TENCENT, …)
 *     1 — OPENAI and ANTHROPIC, the pre-IPO names
 *
 * It is an inference, not a label, and it is wrong in at least two places:
 * SPACEX sits at 100 and ADI at 100 despite both being RWA. The cost of being
 * wrong is a dot of the wrong colour and a market in the wrong filter tab, so
 * the inference is worth it; nothing that moves money reads this.
 *
 * Unknown multipliers fall to crypto because that is the larger group, so a new
 * market the venue adds is mislabelled rather than hidden.
 */
export type Category = "crypto" | "rwa";

/** Symbols the multiplier gets wrong, corrected by hand. Keep this short. */
const KNOWN_RWA = new Set(["SPACEX", "SPCX", "ADI"]);

export function categorise(symbol: string, fundingPremiumMultiplier: number | undefined): Category {
  if (KNOWN_RWA.has(symbol.toUpperCase())) return "rwa";
  if (fundingPremiumMultiplier === 50 || fundingPremiumMultiplier === 1) return "rwa";
  return "crypto";
}
