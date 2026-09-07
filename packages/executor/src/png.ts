import { deflateSync } from "node:zlib";
import { keccak256, stringToHex } from "viem";

/**
 * Dependency-free PNG encoder for the placeholder token logo used when a
 * tweet has no usable image. o1 only accepts PNG/JPEG/WebP/GIF ≤ 2 MB, so an
 * SVG placeholder is not an option. Output: a solid tile with a darker
 * border, colour derived from the ticker so two placeholders differ.
 */

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value);
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  return concat(u32(data.length), typeBytes, data, u32(crc32(concat(typeBytes, data))));
}

export function placeholderColor(seed: string): [number, number, number] {
  const h = keccak256(stringToHex(seed));
  // Keep every channel in 88..215 so the tile reads on both dark and light UIs.
  const ch = (i: number) => 88 + (Number.parseInt(h.slice(2 + i * 2, 4 + i * 2), 16) % 128);
  return [ch(0), ch(1), ch(2)];
}

export function placeholderPng(seed: string, size = 256): Uint8Array {
  const [r, g, b] = placeholderColor(seed);
  const border = Math.max(1, Math.floor(size / 16));
  const stride = 1 + size * 3;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const edge = x < border || y < border || x >= size - border || y >= size - border;
      const k = edge ? 0.55 : 1;
      const p = row + 1 + x * 3;
      raw[p] = Math.round(r * k);
      raw[p + 1] = Math.round(g * k);
      raw[p + 2] = Math.round(b * k);
    }
  }
  const ihdr = concat(u32(size), u32(size), Uint8Array.of(8, 2, 0, 0, 0)); // 8-bit RGB
  return concat(PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0)));
}
