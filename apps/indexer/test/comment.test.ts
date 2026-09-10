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

  it("drops other control characters", () => {
    const raw = `0x410a42${"00".repeat(29)}` as Hex; // "A", newline, "B"
    expect(commentText(raw)).toBe("AB");
    const onlyJunk = `0x1f7f${"00".repeat(30)}` as Hex;
    expect(commentText(onlyJunk)).toBeNull();
  });

  it("stores binary words as null: an address in the comment slot, or bytes that do not decode", () => {
    // The swap that stalled the indexer on 2026-09-10 (block 59551796): a left-padded address.
    expect(commentText("0x0000000000000000000000008eba5e75def517901e4b1c99b2d320b8c557cf7c")).toBeNull();
    expect(commentText(`0x${"ff".repeat(4)}41${"00".repeat(27)}` as Hex)).toBeNull();
  });
});
