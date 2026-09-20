// Conversion between human decimal values ↔ Lighter wire integers.
//
// `base_amount` and `price` go on the wire as integers scaled by 10^decimals, with
// per-market decimals from orderBookDetails. One digit off is a 10x position — so all
// conversions go through strings (no floats), and round-trips are unit-tested both ways.

const DECIMAL_RE = /^(\d+)(?:\.(\d*))?$/;

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new ConversionError(`invalid decimals: ${decimals}`);
  }
}

/** "64479.7" with decimals 1 → 644797n. Rejects precision beyond the market's decimals. */
export function toWire(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) throw new ConversionError(`invalid decimal value: "${value}"`);
  const whole = m[1];
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) {
    throw new ConversionError(
      `excess precision: "${value}" needs ${frac.length} decimals, market only supports ${decimals}`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** 644797n with decimals 1 → "64479.7". Trailing zeros dropped; "0" for zero. */
export function fromWire(value: bigint | number | string, decimals: number): string {
  assertDecimals(decimals);
  const v = BigInt(value);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
