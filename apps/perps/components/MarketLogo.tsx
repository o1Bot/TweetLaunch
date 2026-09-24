import { logoFor, symbolColor } from "@/lib/logos";

/**
 * A market's mark. When there is no logo — every FX pair, every metal, every
 * index — it falls back to the symbol's first letters on a colour derived from
 * the symbol itself, so the market is still recognisable at a glance rather
 * than being one grey square among many.
 *
 * The manifest is bundled, so the choice between a logo and a tile is made
 * during render rather than after an image fails to load: no flash of a
 * placeholder, and no error handler to run per row.
 */
export function MarketLogo({ symbol, size = 22 }: { symbol: string; size?: number }) {
  const src = logoFor(symbol);
  const px = `${size}px`;

  if (src) {
    return (
      <img
        className="mlogo"
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        style={{ width: px, height: px }}
      />
    );
  }

  return (
    <span
      className="mlogo fallback"
      aria-hidden="true"
      style={{ width: px, height: px, background: symbolColor(symbol), fontSize: `${Math.round(size * 0.4)}px` }}
    >
      {symbol.replace(/^1000/, "").slice(0, 2)}
    </span>
  );
}
