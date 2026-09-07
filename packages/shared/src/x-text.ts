/**
 * X counts post length with weights, not code units: every URL is 23
 * characters regardless of its real length, most characters weigh 1, and
 * CJK / emoji weigh 2. Replies that carry two links and a full token
 * address only fit because of the URL rule, so length checks must use this.
 */

export const X_MAX_CHARS = 280;
export const X_URL_LENGTH = 23;

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** Ranges X weighs as a single character; everything else counts double. */
const SINGLE_WEIGHT: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

function charWeight(codePoint: number): number {
  for (const [lo, hi] of SINGLE_WEIGHT) if (codePoint >= lo && codePoint <= hi) return 1;
  return 2;
}

function weightOf(segment: string): number {
  let total = 0;
  for (const ch of segment) total += charWeight(ch.codePointAt(0) ?? 0);
  return total;
}

export function xWeightedLength(text: string): number {
  let length = 0;
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const index = match.index ?? 0;
    length += weightOf(text.slice(last, index)) + X_URL_LENGTH;
    last = index + match[0].length;
  }
  return length + weightOf(text.slice(last));
}

export function fitsX(text: string): boolean {
  return xWeightedLength(text) <= X_MAX_CHARS;
}

/** Shorten by whole code points until the weighted length fits, ending with an ellipsis. */
export function truncateForX(text: string, max = X_MAX_CHARS): string {
  if (xWeightedLength(text) <= max) return text;
  const chars = [...text];
  while (chars.length > 0 && xWeightedLength(`${chars.join("")}…`) > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}
