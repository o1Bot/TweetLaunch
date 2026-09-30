/**
 * Leverage on Lighter is a per-market setting on the account, not a field on
 * the order: the account's initial margin fraction for that market. An order
 * "at 10x" therefore means setting that fraction first and sizing the order to
 * match; an order alone would run at whatever the account had before.
 *
 * Verified against lighter-go commit c26ac340: `SignUpdateLeverage(marketIndex,
 * fraction, marginMode, skipNonce, nonce, apiKeyIndex, accountIndex)`,
 * `TxTypeL2UpdateLeverage = 20`, `MarginFractionTick = 10_000` (the fraction is
 * in 1e-4, so 10x is 1000), `CrossMargin = 0`, `IsolatedMargin = 1`. The
 * venue reports the same value on a position as a percent string
 * (`initial_margin_fraction: "5.00"` = 20x, measured live on 2026-09-30).
 */

export const TX_TYPE_L2_UPDATE_LEVERAGE = 20;
export const MARGIN_MODE = { cross: 0, isolated: 1 } as const;
export type MarginMode = (typeof MARGIN_MODE)[keyof typeof MARGIN_MODE];
export const MARGIN_FRACTION_TICK = 10_000;

/**
 * The initial margin fraction for a whole-number leverage, in the venue's
 * units. Rounded up, so the leverage that results is never above the one
 * asked for: 3x is 3334 (2.9994x), not 3333 (3.0003x).
 */
export function marginFractionFor(leverage: number): number {
  if (!Number.isInteger(leverage) || leverage < 1) throw new RangeError("leverage must be a whole number of at least 1");
  return Math.ceil(MARGIN_FRACTION_TICK / leverage);
}

/** The venue's percent string for a position ("5.00") as the same units, or null when it is not a number. */
export function marginFractionFromPercent(percent: string | number | null | undefined): number | null {
  const n = typeof percent === "string" ? Number(percent) : percent;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
