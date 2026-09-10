import { describe, expect, it } from "vitest";
import { stringToHex, type Hex } from "viem";
import { commentText } from "../src/scanner";

const word = (s: string): Hex => stringToHex(s, { size: 32 });

describe("commentText", () => {
  it("returns the text of a normal comment", () => {
    expect(commentText(word("o1bot.exchange"))).toBe("o1bot.exchange");
  });

  it("is null for an empty or all-zero word", () => {
    expect(commentText("0x")).toBeNull();
    expect(commentText(`0x${"00".repeat(32)}`)).toBeNull();
  });

  it("drops a NUL in the middle of the word, which Postgres rejects as text", () => {
    // "ab\0cd" padded to 32 bytes: the old decoder only trimmed trailing NULs.
    const raw = `0x6162006364${"00".repeat(27)}` as Hex;
    expect(commentText(raw)).toBe("abcd");
  });

  it("drops other control characters and undecodable bytes", () => {
    const raw = `0x${"ff".repeat(4)}0a41${"00".repeat(26)}` as Hex; // four invalid bytes, a newline, "A"
    expect(commentText(raw)).toBe("A");
    const onlyJunk = `0x${"00".repeat(2)}1f7f${"00".repeat(28)}` as Hex;
    expect(commentText(onlyJunk)).toBeNull();
  });
});
