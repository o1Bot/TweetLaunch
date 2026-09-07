/**
 * o1 interface limits (docs.o1.exchange/launchpad/reference/limits, fetched
 * 2026-09-06) plus o1bot's stricter ticker rule.
 */
export const O1_LIMITS = {
  nameMaxChars: 50,
  symbolMaxChars: 11,
  imageMaxBytes: 2 * 1024 * 1024,
  /** o1's own interface signs plain launches with latest block timestamp + 30 minutes. */
  deadlineSeconds: 30 * 60,
  /**
   * The launch-buy adapter reverts with DeadlineTooLong() for long deadlines;
   * live createLaunchAndBuy transactions use block timestamp + 4-5 minutes.
   */
  devBuyDeadlineSeconds: 5 * 60,
  supplyDecimals: 18,
} as const;

/** o1bot accepts uppercase letters and digits only; o1 merely forbids spaces. */
const TICKER_RE = /^[A-Z0-9]{1,11}$/;

export type FieldCheck = { ok: true } | { ok: false; reason: string };

export function validateTokenFields(input: { name: string; symbol: string }): FieldCheck {
  const name = input.name.trim();
  const symbol = input.symbol.trim();
  if (!name) return { ok: false, reason: "token name is empty" };
  if ([...name].length > O1_LIMITS.nameMaxChars) return { ok: false, reason: `token name exceeds ${O1_LIMITS.nameMaxChars} characters` };
  if (!symbol) return { ok: false, reason: "ticker is empty" };
  if (!TICKER_RE.test(symbol)) return { ok: false, reason: "ticker must be 1-11 uppercase letters or digits" };
  return { ok: true };
}
