/**
 * Price math for Uniswap v4 launch pools. All integer arithmetic; prices are
 * returned scaled by 1e18 so they can be stored exactly and formatted late.
 */

export const Q96 = 2n ** 96n;
export const Q192 = 2n ** 192n;
export const PRICE_SCALE = 10n ** 18n;

/**
 * Quote per token (human units) scaled by 1e18, from a pool's sqrtPriceX96.
 *
 * sqrtPriceX96 = sqrt(raw1 / raw0) * 2^96, so raw1-per-raw0 = sq / 2^192.
 * Converting raw ratios to human units multiplies by 10^(dec0 - dec1).
 */
export function priceQuotePerTokenE18(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, quoteDecimals: number, tokenDecimals = 18): bigint {
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const tokenScale = 10n ** BigInt(tokenDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);
  if (tokenIsCurrency0) {
    // quote per token = (sq / 2^192) * 10^tokenDec / 10^quoteDec
    return (sq * PRICE_SCALE * tokenScale) / (Q192 * quoteScale);
  }
  if (sq === 0n) return 0n;
  // token is currency1: quote per token = (2^192 / sq) * 10^tokenDec / 10^quoteDec
  return (Q192 * PRICE_SCALE * tokenScale) / (sq * quoteScale);
}

/** Render an E18-scaled value as a plain decimal string ("0.000318"). */
export function e18ToDecimalString(value: bigint, maxFractionDigits = 18): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / PRICE_SCALE;
  let frac = (abs % PRICE_SCALE).toString().padStart(18, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${out}` : out;
}

/** Parse a decimal string ("0.05") into raw units with `decimals` places. */
export function parseDecimalToRaw(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal: ${value}`);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

/** Raw units → JS number in human units (display only; loses precision). */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function e18ToNumber(value: bigint): number {
  return Number(value) / 1e18;
}
