import manifest from "./logos.json";

/**
 * Logos the site serves itself for assets that are not o1 launches: every
 * stock in o1's quote catalogs, ETH, USDG and USDC, as public/logos/<SYMBOL>.png.
 * `pnpm logos:fetch` keeps the files and the manifest; nothing is hotlinked,
 * so a user's network cannot break them.
 */
const symbols = new Set((manifest as { symbols: string[] }).symbols.map((s) => s.toUpperCase()));

/** The site-relative path of a symbol's logo, or null when there is none. */
export function logoFor(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const raw = symbol.toUpperCase();
  const s = raw === "WETH" ? "ETH" : raw;
  return symbols.has(s) ? `/logos/${s}.png` : null;
}
