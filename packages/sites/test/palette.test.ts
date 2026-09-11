import { describe, expect, it } from "vitest";
import { paletteFromRgba } from "../src/palette";

function pixels(colors: Array<[number, number, number, number, number]>): Uint8Array {
  const out: number[] = [];
  for (const [r, g, b, a, n] of colors) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return new Uint8Array(out);
}

describe("paletteFromRgba", () => {
  it("ranks colours by presence and saturation, skipping transparent pixels", () => {
    const data = pixels([
      [240, 240, 240, 255, 500], // pale background, most pixels
      [244, 196, 48, 255, 200], // vivid yellow
      [17, 17, 17, 255, 100], // near black
      [255, 0, 0, 0, 1000], // transparent red, ignored
    ]);
    const palette = paletteFromRgba(data, 3);
    expect(palette[0]).toBe("#f4c430");
    expect(palette).toContain("#f0f0f0");
    expect(palette).toContain("#111111");
    expect(palette).not.toContain("#ff0000");
  });

  it("merges near-identical shades and returns nothing for an empty image", () => {
    const data = pixels([
      [200, 30, 30, 255, 50],
      [204, 34, 34, 255, 50],
      [198, 28, 33, 255, 50],
    ]);
    expect(paletteFromRgba(data, 5)).toHaveLength(1);
    expect(paletteFromRgba(new Uint8Array(0))).toEqual([]);
    expect(paletteFromRgba(pixels([[1, 2, 3, 0, 10]]))).toEqual([]);
  });
});
