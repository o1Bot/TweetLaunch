import { IMAGE_MAX_BYTES, type ImageMime } from "./metadata";

/**
 * Bring an oversized logo under o1's 2 MB limit instead of refusing it:
 * downscale to at most 1024 px on the long side and re-encode as WebP,
 * lowering quality until it fits. Animated GIFs cannot be shrunk without
 * losing the animation, so they are left to the caller to reject.
 *
 * `sharp` is loaded lazily: the web app imports this package for other
 * things and never compresses (the browser already does before upload).
 */

export const IMAGE_MAX_SIDE = 1024;
const QUALITIES = [85, 70, 55, 40];

export type CompressResult = { ok: true; bytes: Uint8Array; mime: ImageMime; resized: boolean } | { ok: false; reason: "gif" | "still_too_large" | "decode_failed" };

export async function compressImage(bytes: Uint8Array, mime: ImageMime): Promise<CompressResult> {
  if (bytes.length <= IMAGE_MAX_BYTES) return { ok: true, bytes, mime, resized: false };
  if (mime === "image/gif") return { ok: false, reason: "gif" };
  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
  try {
    const base = sharp(bytes, { failOn: "none" }).rotate().resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true });
    for (const quality of QUALITIES) {
      const out = await base.clone().webp({ quality }).toBuffer();
      if (out.length <= IMAGE_MAX_BYTES) return { ok: true, bytes: new Uint8Array(out), mime: "image/webp", resized: true };
    }
    return { ok: false, reason: "still_too_large" };
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
}
