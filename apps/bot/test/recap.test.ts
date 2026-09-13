import { FakeXClient } from "@o1bot/x";
import { describe, expect, it } from "vitest";
import { recapDue, recapText, runRecapOnce, type RecapFigures } from "../src/recap";
import { MemoryBotStore } from "../src/store";

const SITE = "https://o1bot.exchange";
const busy: RecapFigures = { launches: { robinhood: 2, arc: 1 }, trades: 87, volumeUsd: 41_234, top: { ticker: "ADOG", volumeUsd: 12_300, changePct: 38.2 } };

describe("daily recap text", () => {
  it("counts launches per chain, volume, trades and the most traded token", () => {
    expect(recapText(busy, SITE)).toBe("o1bot, last 24h: 3 launches (2 on Robinhood Chain, 1 on Arc), $41.2K traded across 87 trades. Most traded: $ADOG, $12.3K (+38%). Board: https://o1bot.exchange");
  });

  it("keeps a single-chain day short and handles one launch, one trade and unpriced volume", () => {
    expect(recapText({ launches: { base: 1 }, trades: 1, volumeUsd: null, top: null }, SITE)).toBe("o1bot, last 24h: 1 launch on Base, 1 trade. Board: https://o1bot.exchange");
    expect(recapText({ launches: {}, trades: 12, volumeUsd: 950.5, top: { ticker: "CAT", volumeUsd: 950.5, changePct: -4.26 } }, SITE)).toBe("o1bot, last 24h: no new launches, $950.50 traded across 12 trades. Most traded: $CAT, $950.50 (-4.3%). Board: https://o1bot.exchange");
  });

  it("writes large trade counts with a thousands separator", () => {
    expect(recapText({ ...busy, trades: 3103 }, SITE)).toContain("across 3,103 trades");
  });

  it("says nothing on a day without launches or trades", () => {
    expect(recapText({ launches: {}, trades: 0, volumeUsd: null, top: null }, SITE)).toBeNull();
  });

  it("stays within a post", () => {
    expect(recapText(busy, SITE)!.length).toBeLessThanOrEqual(280);
  });
});

describe("daily recap schedule", () => {
  it("is due from the configured hour once per UTC day", () => {
    expect(recapDue(new Date("2026-09-13T12:59:00Z"), 13, null)).toBe(false);
    expect(recapDue(new Date("2026-09-13T13:00:00Z"), 13, null)).toBe(true);
    expect(recapDue(new Date("2026-09-13T20:00:00Z"), 13, "2026-09-13")).toBe(false);
    expect(recapDue(new Date("2026-09-14T13:00:00Z"), 13, "2026-09-13")).toBe(true);
  });

  it("posts once, remembers the day, and skips quiet days without posting", async () => {
    const x = new FakeXClient();
    const store = new MemoryBotStore();
    const deps = { store, x, config: { siteUrl: SITE, dryRun: false } };
    const now = new Date("2026-09-13T13:05:00Z");
    const first = await runRecapOnce(deps, { hourUtc: 13, now, collect: async () => busy });
    expect(first).toMatchObject({ posted: true, reason: "posted" });
    expect(x.posts).toHaveLength(1);
    expect(x.posts[0]).toContain("3 launches");
    // Same day again: nothing, even with fresh figures.
    const again = await runRecapOnce(deps, { hourUtc: 13, now: new Date("2026-09-13T18:00:00Z"), collect: async () => busy });
    expect(again).toMatchObject({ posted: false, reason: "not due" });
    expect(x.posts).toHaveLength(1);
    // Next day is quiet: the day is marked handled, no post.
    const quiet = await runRecapOnce(deps, { hourUtc: 13, now: new Date("2026-09-14T13:00:00Z"), collect: async () => ({ launches: {}, trades: 0, volumeUsd: null, top: null }) });
    expect(quiet).toMatchObject({ posted: false, reason: "quiet day" });
    expect(x.posts).toHaveLength(1);
    expect(await store.getCursor("recap:last")).toContain("2026-09-14");
  });

  it("logs instead of posting in a dry run", async () => {
    const x = new FakeXClient();
    const deps = { store: new MemoryBotStore(), x, config: { siteUrl: SITE, dryRun: true } };
    const out = await runRecapOnce(deps, { hourUtc: 13, now: new Date("2026-09-13T13:05:00Z"), collect: async () => busy });
    expect(out).toMatchObject({ posted: false, reason: "dry run" });
    expect(out.text).toContain("3 launches");
    expect(x.posts).toHaveLength(0);
  });
});
