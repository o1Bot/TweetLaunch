import { describe, expect, it } from "vitest";
import { indexerHealth, STALE_AFTER_MS } from "../lib/health";

const now = new Date("2026-09-10T19:00:00Z");

describe("indexerHealth", () => {
  it("is fresh while the cursor moved within the window", () => {
    const h = indexerHealth(new Date(now.getTime() - 20_000), now);
    expect(h).toEqual({ ok: true, ageSeconds: 20, since: null });
  });

  it("is delayed once the cursor sits still past the window, and says since when", () => {
    const cursorAt = new Date(now.getTime() - STALE_AFTER_MS - 1000);
    const h = indexerHealth(cursorAt, now);
    expect(h.ok).toBe(false);
    expect(h.ageSeconds).toBe(301);
    expect(h.since).toBe(cursorAt.toISOString());
  });

  it("is delayed without a cursor at all", () => {
    expect(indexerHealth(null, now)).toEqual({ ok: false, ageSeconds: null, since: null });
  });
});
