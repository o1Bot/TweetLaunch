import manifest from "./logos.json";

/**
 * Logos this app serves itself, as public/logos/<SYMBOL>.png, kept by
 * `pnpm logos:perps`. Nothing is hotlinked, so a user's network cannot break
 * them and no third party can take them away.
 *
 * Coverage is partial on purpose: 162 of 210 markets at the last run. The rest
 * are things that have no logo to find — EURUSD is a pair, XAU is a metal,
 * US500 is an index — plus a handful of Asian and pre-IPO names no public
 * source carries. Those draw a lettered tile instead of a generic icon that
 * would imply a brand exists.
 */
const symbols = new Set((manifest as { symbols: string[] }).symbols.map((s) => s.toUpperCase()));

/** The app-relative path of a symbol's logo, or null when there is none. */
export function logoFor(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const s = symbol.toUpperCase();
  return symbols.has(s) ? `/logos/${s}.png` : null;
}

/**
 * A stable colour for a symbol with no logo. Hashing the symbol means the same
 * market is the same colour on every render and in every list, so it stays
 * recognisable even without a mark — which a single grey placeholder would not.
 */
export function symbolColor(symbol: string): string {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 46%)`;
}
