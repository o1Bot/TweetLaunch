/**
 * The colours a logo is made of, for the agent's palette. `sharp` is loaded
 * lazily so that importing this package (the web app does, for rendering)
 * never loads the native module; only the bot worker, which has the logo
 * bytes at hand, calls `logoPalette`.
 */

const SAMPLE_SIDE = 48;
/** Bucket each channel into 32 steps so near-identical shades count together. */
const STEP = 8;

type Bucket = { r: number; g: number; b: number; n: number };

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Up to `limit` colours as #rrggbb, most present first; saturated colours are preferred over greys, transparent pixels are skipped. */
export function paletteFromRgba(data: Uint8Array | Buffer, limit = 5): string[] {
  const buckets = new Map<string, Bucket>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < 128) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = `${Math.floor(r / STEP)},${Math.floor(g / STEP)},${Math.floor(b / STEP)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n++;
    } else buckets.set(key, { r, g, b, n: 1 });
  }
  const total = [...buckets.values()].reduce((s, b) => s + b.n, 0);
  if (total === 0) return [];
  const ranked = [...buckets.values()]
    .map((b) => ({ r: Math.round(b.r / b.n), g: Math.round(b.g / b.n), b: Math.round(b.b / b.n), share: b.n / total }))
    // Weight by presence and by saturation so a small but vivid accent beats a large grey background.
    .map((c) => ({ ...c, score: c.share * (0.35 + saturation(c.r, c.g, c.b)) }))
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  for (const c of ranked) {
    const h = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
    // Skip colours too close to one already picked.
    if (out.some((o) => distance(o, h) < 40)) continue;
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

function distance(a: string, b: string): number {
  const p = (s: string) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  return Math.sqrt((ar! - br!) ** 2 + (ag! - bg!) ** 2 + (ab! - bb!) ** 2);
}

/** Palette of an image (PNG, JPEG, WebP, GIF); empty when the bytes cannot be read. */
export async function logoPalette(bytes: Uint8Array, limit = 5): Promise<string[]> {
  try {
    const sharp = (await import("sharp")).default;
    const { data } = await sharp(bytes, { failOn: "none", animated: false }).resize({ width: SAMPLE_SIDE, height: SAMPLE_SIDE, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return paletteFromRgba(data, limit);
  } catch {
    return [];
  }
}
