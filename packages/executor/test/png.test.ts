import { describe, expect, it } from "vitest";
import { sniffImageMime, IMAGE_MAX_BYTES } from "../src/metadata";
import { placeholderColor, placeholderPng, PNG_SIGNATURE } from "../src/png";

describe("placeholder PNG", () => {
  it("is a well-formed PNG under o1's size limit", () => {
    const png = placeholderPng("RUGRAT");
    expect(Array.from(png.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
    expect(png.length).toBeLessThan(IMAGE_MAX_BYTES);
    expect(sniffImageMime(png)).toBe("image/png");
  });

  it("is deterministic per ticker and differs between tickers", () => {
    expect(placeholderPng("ABC")).toEqual(placeholderPng("ABC"));
    expect(placeholderColor("ABC")).not.toEqual(placeholderColor("XYZ"));
  });
});

describe("sniffImageMime", () => {
  it("detects jpeg, gif, webp and rejects svg", () => {
    expect(sniffImageMime(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(new TextEncoder().encode("GIF89a......"))).toBe("image/gif");
    expect(sniffImageMime(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns=..."))).toBeNull();
  });
});
