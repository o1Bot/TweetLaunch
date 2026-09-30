import { MARGIN_MODE, OrderBuildError, buildCloseOrder, buildCreateOrder, marginFractionFor, type BuiltOrder } from "@o1bot/lighter";
import type { PerpCommand } from "@o1bot/parser";
import { noAlerts, postUrl, type Alerter } from "./alerts";
import type { BotConfig } from "./config";
import type { PerpsStore } from "./perps-store";
import type { PerpMarket, PerpsVenue, VenuePosition } from "./perps-venue";
import { replies } from "./replies";
import { checkRate, startOfUtcDay } from "./validator";

/**
 * A long, a short or a close asked for in a post, on the poster's own Lighter
 * account, signed with the key the bot registered there when they opted in.
 * The command names a side, a market, a leverage and the collateral; nothing
 * else in the post can influence what is signed. Every figure is checked
 * against the user's own caps, the market's limits and the account's balance
 * before anything is signed, and the order that goes out is a market order
 * with a price guard, never a resting one.
 *
 * Leverage on Lighter is a setting on the account per market, not a field on
 * the order, so "10x" means: set that market to 10x, then send the order.
 * Everything venue-facing goes through `PerpsVenue`, so the flow runs in
 * tests with a fake.
 */

export type PerpCoreInput = {
  mentionId: string;
  tweetId: string;
  xUserId: string;
  handle: string;
  cmd: PerpCommand;
};

export type PerpCoreDeps = {
  store: PerpsStore;
  venue: PerpsVenue;
  config: BotConfig;
  alerts?: Alerter;
  now: () => Date;
  /** Pause between fill checks; injectable so tests do not wait. */
  wait?: (ms: number) => Promise<void>;
};

export type PerpCoreResult =
  | { ok: false; outcome: "rejected"; error: string; userText: string }
  | { ok: false; outcome: "failed"; error: string; userText: string; orderId: string | null }
  | { ok: true; dryRun: true; orderId: string; userText: string }
  | { ok: true; dryRun: false; orderId: string; txHash: string; filled: boolean; userText: string };

type Logger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

/** Every Lighter market takes orders of at least this much; the market's own minimum applies on top. */
export const MIN_ORDER_USDC = 10;
/** How often, and how far apart, the position is re-read after an order to see whether it filled. */
const FILL_CHECKS = 6;
const FILL_CHECK_MS = 1_500;

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sizeOf = (p: VenuePosition | undefined): number => (p ? Number(p.size) || 0 : 0);
/** Signed contracts: above zero long, below zero short. */
const signedSize = (p: VenuePosition | undefined): number => sizeOf(p) * (p?.sign ?? 1);

export function formatPrice(price: number, decimals: number): string {
  const d = Math.min(Math.max(decimals, 0), 6);
  return price.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const formatUsd = (n: number): string => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function runPerp(input: PerpCoreInput, deps: PerpCoreDeps, log: Logger): Promise<PerpCoreResult> {
  const { store, venue, config } = deps;
  const { cmd } = input;
  const perpsUrl = config.perpsSiteUrl;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rejected = (error: string, userText: string): PerpCoreResult => ({ ok: false, outcome: "rejected", error, userText });

  // 1. Opt-in: the account, the bot's key on it, and the user's own caps.
  const state = await store.account(input.xUserId);
  if (state.state !== "active") return rejected(`perps from a post: ${state.state}`, replies.perpsNotEnabled(state.state, perpsUrl));
  const account = state.account;

  // 2. Rate limits, before any read of the venue.
  const now = deps.now();
  const rate = checkRate({
    lastLaunchAt: await store.lastOrderAt(input.xUserId),
    launchesToday: await store.ordersSince(input.xUserId, startOfUtcDay(now)),
    now,
    cooldownSeconds: config.perpsCooldownSeconds,
    maxPerDay: config.maxPerpOrdersPerDay,
  });
  if (!rate.ok) return rejected(`rate limited: ${rate.reason}`, rate.reason === "daily_cap" ? replies.perpsDailyCap() : replies.perpsSlowDown(rate.retryAfterSeconds));

  // 3. The market and the account as the venue sees them right now.
  let market: PerpMarket | null;
  let before: VenuePosition | undefined;
  let availableUsdc: number;
  try {
    market = await venue.market(cmd.market);
    if (!market) return rejected(`unknown market ${cmd.market}`, replies.perpsUnknownMarket(cmd.market, perpsUrl));
    const va = await venue.account(account.accountIndex);
    before = va.positions.get(market.marketId);
    availableUsdc = va.availableUsdc;
  } catch (err) {
    log.warn({ err: errMessage(err) }, "could not read the venue for a perp order");
    return { ok: false, outcome: "failed", error: `venue read: ${errMessage(err)}`, userText: replies.perpsVenueDown(), orderId: null };
  }
  if (!(market.markPrice > 0)) return { ok: false, outcome: "failed", error: `no mark price for ${market.symbol}`, userText: replies.perpsVenueDown(), orderId: null };

  const slippage = config.perpsSlippageBps / 10_000;
  const wire = { market_id: market.marketId, supported_price_decimals: market.priceDecimals, supported_size_decimals: market.sizeDecimals };
  const held = signedSize(before);

  // 4. Build the order; every refusal happens here, before anything is signed.
  let order: BuiltOrder;
  let side: "long" | "short";
  let leverageChange: { marketId: number; fraction: number; marginMode: number } | undefined;
  let notionalUsd: number | null = null;
  let marginUsd: number | null = null;

  try {
    if (cmd.action === "open") {
      side = cmd.side!;
      const leverage = cmd.leverage!;
      const ceiling = Math.min(account.maxLeverage, market.maxLeverage);
      if (leverage > ceiling) {
        return rejected(`leverage ${leverage} above ${ceiling}`, replies.perpsLeverageTooHigh(market.symbol, ceiling, market.maxLeverage < account.maxLeverage ? "market" : "cap", perpsUrl));
      }
      marginUsd = Number(cmd.marginUsdc);
      notionalUsd = marginUsd * leverage;
      if (notionalUsd > account.maxNotionalUsd) return rejected(`notional ${notionalUsd} above cap ${account.maxNotionalUsd}`, replies.perpsTooLarge(formatUsd(notionalUsd), formatUsd(account.maxNotionalUsd), perpsUrl));
      const floor = Math.max(MIN_ORDER_USDC, market.minQuote);
      if (notionalUsd < floor) return rejected(`notional ${notionalUsd} below ${floor}`, replies.perpsTooSmall(market.symbol, formatUsd(floor)));
      if (marginUsd > availableUsdc) return rejected(`margin ${marginUsd} above available ${availableUsdc}`, replies.perpsInsufficient(formatUsd(marginUsd - availableUsdc), formatUsd(availableUsdc), perpsUrl));
      // An order against an open position would shrink or flip it, which is not what "long" or "short" says.
      if ((side === "long" && held < 0) || (side === "short" && held > 0)) {
        return rejected(`opposite position open on ${market.symbol}`, replies.perpsOppositeOpen(market.symbol, held > 0 ? "long" : "short"));
      }
      order = buildCreateOrder({ side, type: "market", notionalUsd, price: market.markPrice, slippage, market: wire });
      if (Number(order.contracts) < market.minBase) return rejected(`size ${order.contracts} below ${market.minBase}`, replies.perpsTooSmall(market.symbol, formatUsd(floor)));
      // The order builder floors the size to the market's resolution; what is shown and stored is what is sent.
      notionalUsd = Number(order.contracts) * market.markPrice;

      const fraction = marginFractionFor(leverage);
      if (before?.marginFraction !== fraction) leverageChange = { marketId: market.marketId, fraction, marginMode: before?.marginMode ?? MARGIN_MODE.cross };
    } else {
      if (held === 0) return rejected(`no position on ${market.symbol}`, replies.perpsNoPosition(market.symbol));
      side = held > 0 ? "long" : "short";
      const portion = cmd.closePortion ?? { kind: "all" as const };
      const size = portion.kind === "all" ? before!.size : (Math.abs(held) * (portion.value / 100)).toFixed(market.sizeDecimals + 2);
      order = buildCloseOrder({ positionSign: before!.sign, positionSize: size, markPrice: market.markPrice, slippage, market: wire });
      notionalUsd = Number(order.contracts) * market.markPrice;
    }
  } catch (err) {
    if (err instanceof OrderBuildError) return rejected(`order build: ${err.message}`, replies.perpsTooSmall(market.symbol, formatUsd(Math.max(MIN_ORDER_USDC, market.minQuote))));
    throw err;
  }

  const guardPrice = (order.price / 10 ** market.priceDecimals).toFixed(market.priceDecimals);
  const leverage = cmd.action === "open" ? cmd.leverage : null;
  const { id: orderId } = await store.createOrder({
    mentionId: input.mentionId,
    xUserId: input.xUserId,
    accountIndex: account.accountIndex,
    marketId: market.marketId,
    symbol: market.symbol,
    action: cmd.action,
    side,
    leverage,
    marginUsd: marginUsd === null ? null : String(marginUsd),
    notionalUsd: notionalUsd === null ? null : notionalUsd.toFixed(2),
    baseAmount: order.contracts,
    guardPrice,
    status: config.dryRun ? "DRY_RUN" : "SIGNING",
  });

  const page = `${perpsUrl}/perps/${market.symbol}`;
  const mark = formatPrice(market.markPrice, market.priceDecimals);

  if (config.dryRun) {
    const userText = cmd.action === "open" ? replies.perpsDryRunOpen({ side, symbol: market.symbol, contracts: order.contracts, mark, leverage: leverage!, margin: formatUsd(marginUsd!), notional: formatUsd(notionalUsd!) }) : replies.perpsDryRunClose({ side, symbol: market.symbol, contracts: order.contracts, mark });
    await store.updateOrder(orderId, { userMessage: userText });
    log.info({ orderId, market: market.symbol, action: cmd.action, side, contracts: order.contracts, leverageChange: Boolean(leverageChange) }, "dry run: would send a perp order");
    return { ok: true, dryRun: true, orderId, userText };
  }

  // 5. Sign and send: the leverage change when one is needed, then the order.
  let sent: { leverageTxHash: string | null; orderTxHash: string };
  try {
    sent = await venue.send({ accountIndex: account.accountIndex, apiKeyIndex: account.apiKeyIndex, sealedKey: account.sealedKey, ...(leverageChange ? { leverage: leverageChange } : {}), order });
  } catch (err) {
    const error = errMessage(err);
    const userText = replies.perpsFailed(error);
    await store.updateOrder(orderId, { status: "FAILED", error: error.slice(0, 1000), userMessage: userText });
    log.error({ orderId, err: error }, "perp order failed");
    (deps.alerts ?? noAlerts).send({ kind: "trade_failed", title: "Perp order failed", key: `perp:${input.xUserId}`, fields: [["User", `@${input.handle}`], ["Post", postUrl(input.handle, input.tweetId)], ["Order", `${cmd.action} ${side} ${market.symbol} ${order.contracts}`], ["Error", error]] });
    return { ok: false, outcome: "failed", error, userText, orderId };
  }
  await store.updateOrder(orderId, { status: "SENT", leverageTxHash: sent.leverageTxHash, txHash: sent.orderTxHash });

  // 6. A market order either fills at once or is cancelled by its guard. Read the position back to say which.
  let after: VenuePosition | undefined = before;
  let filled = false;
  for (let i = 0; i < FILL_CHECKS && !filled; i++) {
    await wait(FILL_CHECK_MS);
    try {
      after = (await venue.account(account.accountIndex)).positions.get(market.marketId);
    } catch (err) {
      log.warn({ orderId, err: errMessage(err) }, "could not re-read the position after a perp order");
      continue;
    }
    filled = signedSize(after) !== held;
  }

  let userText: string;
  if (!filled) {
    userText = replies.perpsUnfilled(market.symbol, page);
    await store.updateOrder(orderId, { status: "UNFILLED", userMessage: userText });
  } else if (cmd.action === "open") {
    const liq = after?.liquidationPrice ? formatPrice(after.liquidationPrice, market.priceDecimals) : null;
    const entry = after && after.avgEntry > 0 ? formatPrice(after.avgEntry, market.priceDecimals) : mark;
    userText = replies.perpsOpened({ side, symbol: market.symbol, contracts: order.contracts, entry, leverage: leverage!, margin: formatUsd(marginUsd!), notional: formatUsd(notionalUsd!), liquidation: liq, page });
    await store.updateOrder(orderId, { status: "FILLED", filledBase: order.contracts, entryPrice: after && after.avgEntry > 0 ? String(after.avgEntry) : null, userMessage: userText });
  } else {
    const remaining = sizeOf(after);
    userText = replies.perpsClosed({ side, symbol: market.symbol, contracts: order.contracts, remaining: remaining > 0 ? after!.size : null, page });
    await store.updateOrder(orderId, { status: "FILLED", filledBase: order.contracts, userMessage: userText });
  }
  log.info({ orderId, market: market.symbol, action: cmd.action, side, contracts: order.contracts, filled, txHash: sent.orderTxHash }, "perp order sent");
  return { ok: true, dryRun: false, orderId, txHash: sent.orderTxHash, filled, userText };
}
