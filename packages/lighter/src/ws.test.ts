import { describe, expect, it } from "vitest";
import { BookState } from "./ws";

// Message shapes from the live probe 2026-07-29 (docs — spikes/wasm-signer & scratchpad ws-probe).
const snapshot = {
  offset: 1000,
  last_updated_at: 111,
  asks: [
    { price: "64550.9", size: "0.04460" },
    { price: "64584.1", size: "0.20796" },
  ],
  bids: [
    { price: "64463.2", size: "0.12411" },
    { price: "64400.0", size: "0.50000" },
  ],
};

describe("BookState", () => {
  it("snapshot: bids descending, asks ascending", () => {
    const b = new BookState();
    b.applySnapshot(snapshot);
    const s = b.toSorted();
    expect(s.offset).toBe(1000);
    expect(s.bids.map((l) => l.price)).toEqual(["64463.2", "64400.0"]);
    expect(s.asks.map((l) => l.price)).toEqual(["64550.9", "64584.1"]);
  });

  it("update: size 0.00000 removes the level, a new size replaces it", () => {
    const b = new BookState();
    b.applySnapshot(snapshot);
    const ok = b.applyUpdate({
      offset: 1001,
      bids: [
        { price: "64463.2", size: "0.00000" },
        { price: "64410.5", size: "0.30000" },
      ],
      asks: [{ price: "64550.9", size: "0.09000" }],
    });
    expect(ok).toBe(true);
    const s = b.toSorted();
    expect(s.bids.map((l) => l.price)).toEqual(["64410.5", "64400.0"]);
    expect(s.asks[0]).toEqual({ price: "64550.9", size: "0.09000" });
  });

  it("stale message (offset ≤ current) is skipped without corrupting the book", () => {
    const b = new BookState();
    b.applySnapshot(snapshot);
    const ok = b.applyUpdate({ offset: 1000, bids: [{ price: "64463.2", size: "9.9" }] });
    expect(ok).toBe(true);
    expect(b.toSorted().bids[0]).toEqual({ price: "64463.2", size: "0.12411" });
  });

  it("offset gap detected → false (fresh snapshot required)", () => {
    const b = new BookState();
    b.applySnapshot(snapshot);
    expect(b.applyUpdate({ offset: 1005, bids: [] })).toBe(false);
  });

  it("nonce chain: begin_nonce must == the previous nonce", () => {
    const b = new BookState();
    b.applySnapshot({ ...snapshot, nonce: 500 });
    // healthy chain
    expect(b.applyUpdate({ offset: 1001, begin_nonce: 500, nonce: 510, bids: [] })).toBe(true);
    // chain broken — message lost in between
    expect(b.applyUpdate({ offset: 1002, begin_nonce: 999, nonce: 1010, bids: [] })).toBe(false);
  });

  it("mainnet: offset jumping >1 is VALID as long as the nonce chain is intact", () => {
    const b = new BookState();
    b.applySnapshot({ ...snapshot, nonce: 500 });
    // real mainnet pattern: +3, +21 between messages — not a gap
    expect(b.applyUpdate({ offset: 1003, begin_nonce: 500, nonce: 540, bids: [] })).toBe(true);
    expect(b.applyUpdate({ offset: 1024, begin_nonce: 540, nonce: 590, bids: [] })).toBe(true);
    expect(b.offset).toBe(1024);
  });

  it("without nonce fields, the offset gate still works on its own", () => {
    const b = new BookState();
    b.applySnapshot(snapshot); // no nonce
    expect(b.applyUpdate({ offset: 1001, bids: [] })).toBe(true);
  });

  it("empty book (dead spot market) is still valid", () => {
    const b = new BookState();
    b.applySnapshot({ offset: 5, asks: [], bids: [] });
    const s = b.toSorted();
    expect(s.bids).toEqual([]);
    expect(s.asks).toEqual([]);
  });
});
