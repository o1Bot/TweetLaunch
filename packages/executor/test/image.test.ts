import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressImage, IMAGE_MAX_SIDE } from "../src/image";
import { IMAGE_MAX_BYTES, sniffImageMime } from "../src/metadata";

/** A noisy PNG large enough to blow past 2 MB (noise does not compress). */
async function bigPng(side: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(side * side * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return new Uint8Array(await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer());
}

describe("compressImage", () => {
  it("leaves small images alone", async () => {
    const small = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } }).png().toBuffer());
    const out = await compressImage(small, "image/png");
    expect(out).toMatchObject({ ok: true, resized: false, mime: "image/png" });
  });

  it("downscales an oversized PNG to WebP under the limit", async () => {
    const big = await bigPng(1600);
    expect(big.length).toBeGreaterThan(IMAGE_MAX_BYTES);
    const out = await compressImage(big, "image/png");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resized).toBe(true);
    expect(out.mime).toBe("image/webp");
    expect(out.bytes.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(sniffImageMime(out.bytes)).toBe("image/webp");
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(IMAGE_MAX_SIDE);
  });

  it("refuses to re-encode an oversized GIF", async () => {
    const out = await compressImage(new Uint8Array(IMAGE_MAX_BYTES + 1), "image/gif");
    expect(out).toEqual({ ok: false, reason: "gif" });
  });
});
