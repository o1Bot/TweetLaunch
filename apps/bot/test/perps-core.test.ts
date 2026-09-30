import { describe, expect, it, vi } from "vitest";
import { MARGIN_MODE, marginFractionFor } from "@o1bot/lighter";
import type { PerpCommand } from "@o1bot/parser";
import type { BotConfig } from "../src/config";

vi.mock("@o1bot/db", () => ({ db: () => { throw new Error("no database in this test"); } }));

const { runPerp } = await import("../src/perps-core");
const { MemoryPerpsStore } = await import("../src/perps-store");
type Venue = import("../src/perps-venue").PerpsVenue;
type VenuePosition = import("../src/perps-venue").VenuePosition;
type SendInput = import("../src/perps-venue").PerpSendInput;

const NOW = new Date("2026-09-30T12:00:00Z");
const config = { dryRun: false, perpsSiteUrl: "https://perps.o1bot.exchange", perpsCooldownSeconds: 10, maxPerpOrdersPerDay: 50, perpsSlippageBps: 100 } as BotConfig;
const log = { info: () => {}, warn: () => {}, error: () => {} };

const BTC = { marketId: 1, symbol: "BTC", markPrice: 80_000, priceDecimals: 1, sizeDecimals: 5, maxLeverage: 50, minBase: 0.00007, minQuote: 10 };
const flat = (over: Partial<VenuePosition> = {}): VenuePosition => ({ sign: 1, size: "0.00000", avgEntry: 0, liquidationPrice: null, marginFraction: 500, marginMode: 0, ...over });

/** A venue that fills every order it is sent, at the mark. */
function fakeVenue(start: { available?: number; position?: VenuePosition; fills?: boolean } = {}) {
  const sent: SendInput[] = [];
  let position: VenuePosition | undefined = start.position ?? flat();
  const venue: Venue = {
    market: async (symbol) => (symbol.toUpperCase() === "BTC" ? BTC : null),
    account: async () => ({ availableUsdc: start.available ?? 100, positions: new Map(position ? [[BTC.marketId, position]] : []) }),
    send: async (input) => {
      sent.push(input);
      if (start.fills !== false) {
        const size = input.order.baseAmount / 1e5;
        const held = (Number(position?.size) || 0) * (position?.sign ?? 1);
        const next = held + (input.order.isAsk ? -size : size);
        position = { sign: next < 0 ? -1 : 1, size: Math.abs(next).toFixed(5), avgEntry: next === 0 ? 0 : BTC.markPrice, liquidationPrice: next === 0 ? null : 72_000, marginFraction: input.leverage?.fraction ?? position?.marginFraction ?? null, marginMode: 0 };
      }
      return { leverageTxHash: input.leverage ? "0xlev" : null, orderTxHash: "0xorder" };
    },
  };
  return { venue, sent };
}

function setup(venueStart: Parameters<typeof fakeVenue>[0] = {}, over: { maxNotionalUsd?: number; maxLeverage?: number; dryRun?: boolean } = {}) {
  const store = new MemoryPerpsStore(() => NOW);
  store.accounts.set("u1", { state: "active", account: { xUserId: "u1", accountIndex: 750972, apiKeyIndex: 5, sealedKey: "s1.sealed", maxNotionalUsd: over.maxNotionalUsd ?? 1000, maxLeverage: over.maxLeverage ?? 20 } });
  const { venue, sent } = fakeVenue(venueStart);
  const deps = { store, venue, config: { ...config, dryRun: over.dryRun ?? false }, now: () => NOW, wait: async () => {} };
  const run = (cmd: PerpCommand, xUserId = "u1") => runPerp({ mentionId: `m${store.orders.length + 1}`, tweetId: "t1", xUserId, handle: "alice", cmd }, deps, log);
  return { store, sent, run };
}

const open = (over: Partial<PerpCommand> = {}): PerpCommand => ({ kind: "perp", action: "open", side: "long", market: "BTC", leverage: 10, marginUsdc: "50", closePortion: null, language: "en", reason: "test", ...over });
const close = (over: Partial<PerpCommand> = {}): PerpCommand => ({ kind: "perp", action: "close", side: null, market: "BTC", leverage: null, marginUsdc: null, closePortion: { kind: "all" }, language: "en", reason: "test", ...over });

describe("runPerp: opening", () => {
  it("sets the market's leverage, then sends a market order sized collateral times leverage", async () => {
    const { store, sent, run } = setup();
    const r = await run(open());
    expect(r).toMatchObject({ ok: true, dryRun: false, txHash: "0xorder", filled: true });
    expect(sent).toHaveLength(1);
    // The account sat at 20x (fraction 500); the order asks for 10x.
    expect(sent[0]!.leverage).toEqual({ marketId: 1, fraction: marginFractionFor(10), marginMode: MARGIN_MODE.cross });
    // 50 USDC at 10x = 500 USDC at 80,000 = 0.00625 BTC; guard 1% above the mark for a buy.
    expect(sent[0]!.order).toMatchObject({ marketIndex: 1, baseAmount: 625, isAsk: 0, reduceOnly: 0, price: 808_000, contracts: "0.00625" });
    expect(sent[0]!).toMatchObject({ accountIndex: 750972, apiKeyIndex: 5, sealedKey: "s1.sealed" });
    expect(store.orders[0]).toMatchObject({ status: "FILLED", action: "open", side: "long", leverage: 10, marginUsd: "50", notionalUsd: "500.00", baseAmount: "0.00625", guardPrice: "80800.0", txHash: "0xorder", leverageTxHash: "0xlev" });
    expect((r as { userText: string }).userText).toBe("Long 0.00625 BTC at 80,000.0, 10x on 50.00 USDC (a 500.00 USDC position). Liquidation near 72,000.0.\nManage it: https://perps.o1bot.exchange/perps/BTC");
  });

  it("leaves the leverage alone when the account already has it", async () => {
    const { sent, run } = setup({ position: flat({ marginFraction: marginFractionFor(10) }) });
    await run(open());
    expect(sent[0]!.leverage).toBeUndefined();
  });

  it("sells for a short, with the guard below the mark", async () => {
    const { sent, run } = setup();
    await run(open({ side: "short", leverage: 5, marginUsdc: "20" }));
    expect(sent[0]!.order).toMatchObject({ isAsk: 1, baseAmount: 125, price: 792_000 });
  });

  it("holds the user's own caps and the market's ceiling before anything is signed", async () => {
    const capped = setup({}, { maxNotionalUsd: 300, maxLeverage: 10 });
    const big = await capped.run(open());
    expect(big).toMatchObject({ ok: false, outcome: "rejected" });
    expect((big as { userText: string }).userText).toContain("above your cap of 300.00 USDC");
    const lev = await capped.run(open({ leverage: 15, marginUsdc: "10" }));
    expect((lev as { userText: string }).userText).toContain("your own leverage cap of 10x");
    const market = await setup({}, { maxLeverage: 100 }).run(open({ leverage: 75, marginUsdc: "10" }));
    expect((market as { userText: string }).userText).toBe("BTC goes up to 50x on Lighter. Post again with 50x or less.");
    expect(capped.sent).toHaveLength(0);
    expect(capped.store.orders).toHaveLength(0);
  });

  it("refuses an order below the venue's minimum and collateral the account does not have", async () => {
    const { sent, run } = setup({ available: 30 });
    expect(((await run(open({ leverage: 1, marginUsdc: "5" }))) as { userText: string }).userText).toContain("at least 10.00 USDC");
    const short = await run(open({ marginUsdc: "50" }));
    expect((short as { userText: string }).userText).toBe("Your Lighter account has 30.00 USDC free, 20.00 short of that collateral. Deposit at https://perps.o1bot.exchange/start or lower the amount.");
    expect(sent).toHaveLength(0);
  });

  it("does not let a long shrink or flip an open short", async () => {
    const { sent, run } = setup({ position: flat({ sign: -1, size: "0.01000", avgEntry: 80_000 }) });
    const r = await run(open());
    expect((r as { userText: string }).userText).toContain("You have an open short on BTC");
    expect(sent).toHaveLength(0);
  });

  it("says so when the order was sent but the guard cancelled it", async () => {
    const { store, run } = setup({ fills: false });
    const r = await run(open());
    expect(r).toMatchObject({ ok: true, filled: false });
    expect((r as { userText: string }).userText).toContain("did not fill inside its price guard");
    expect(store.orders[0]!.status).toBe("UNFILLED");
  });

  it("signs nothing in a dry run, but records what it would have sent", async () => {
    const { store, sent, run } = setup({}, { dryRun: true });
    const r = await run(open());
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect((r as { userText: string }).userText).toBe("Dry run: would go long 0.00625 BTC near 80,000.0, 10x on 50.00 USDC (a 500.00 USDC position). Nothing was sent.");
    expect(sent).toHaveLength(0);
    expect(store.orders[0]).toMatchObject({ status: "DRY_RUN", baseAmount: "0.00625" });
  });
});

describe("runPerp: closing", () => {
  const long = flat({ sign: 1, size: "0.00625", avgEntry: 80_000, liquidationPrice: 72_000, marginFraction: 1000 });

  it("closes the whole position with a reduce-only order on the other side", async () => {
    const { store, sent, run } = setup({ position: long });
    const r = await run(close());
    expect(sent[0]!.order).toMatchObject({ isAsk: 1, reduceOnly: 1, baseAmount: 625, price: 792_000 });
    expect(sent[0]!.leverage).toBeUndefined();
    expect((r as { userText: string }).userText).toBe("Closed your BTC long (0.00625 BTC). The position is flat.\nhttps://perps.o1bot.exchange/perps/BTC");
    expect(store.orders[0]).toMatchObject({ status: "FILLED", action: "close", side: "long" });
  });

  it("closes a part and says what is left", async () => {
    const { sent, run } = setup({ position: long });
    const r = await run(close({ closePortion: { kind: "percent", value: 50 } }));
    // Half of 0.00625 is 0.003125, floored to the market's five decimals.
    expect(sent[0]!.order).toMatchObject({ baseAmount: 312, reduceOnly: 1 });
    expect((r as { userText: string }).userText).toBe("Closed 0.00312 BTC of your long; 0.00313 BTC is still open.\nhttps://perps.o1bot.exchange/perps/BTC");
  });

  it("has nothing to close on a flat market", async () => {
    const { sent, run } = setup();
    expect(((await run(close())) as { userText: string }).userText).toBe("You have no open position on BTC to close.");
    expect(sent).toHaveLength(0);
  });
});

describe("runPerp: who may trade, and how often", () => {
  it("refuses an account that has not opted in, with where to do it", async () => {
    const { sent, run } = setup();
    const r = await run(open(), "stranger");
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
    expect((r as { userText: string }).userText).toContain("step 4 at https://perps.o1bot.exchange/start");
    expect(sent).toHaveLength(0);
  });

  it("tells a user whose key is still registering to wait", async () => {
    const { store, run } = setup();
    store.accounts.set("u2", { state: "pending" });
    expect(((await run(open(), "u2")) as { userText: string }).userText).toContain("still registering its key");
  });

  it("names a market Lighter does not have", async () => {
    const { run } = setup();
    expect(((await run(open({ market: "DOGWIFHAT" }))) as { userText: string }).userText).toContain("no active market called DOGWIFHAT");
  });

  it("spaces orders from one account", async () => {
    const { sent, run } = setup();
    await run(open({ marginUsdc: "10" }));
    const again = await run(open({ marginUsdc: "10" }));
    expect((again as { userText: string }).userText).toContain("One perp order every few seconds");
    expect(sent).toHaveLength(1);
  });

  it("reports a venue refusal without claiming anything opened", async () => {
    const { store } = setup();
    const refusing: Venue = {
      ...fakeVenue().venue,
      send: async () => {
        throw new Error("sendTx rejected: not enough margin");
      },
    };
    const r = await runPerp({ mentionId: "mx", tweetId: "t1", xUserId: "u1", handle: "alice", cmd: open() }, { store, venue: refusing, config, now: () => NOW, wait: async () => {} }, log);
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect((r as { userText: string }).userText).toBe("The order did not go through (sendTx rejected: not enough margin). Nothing was opened. Post again to retry.");
    expect(store.orders[0]).toMatchObject({ status: "FAILED", error: "sendTx rejected: not enough margin" });
  });
});
