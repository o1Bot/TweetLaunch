import { db } from "@o1bot/db";
import { quoteUsd } from "@o1bot/executor";
import { formatUsd } from "@o1bot/market";
import { chainKeyById, logger, type ChainKey } from "@o1bot/shared";
import type { XClient } from "@o1bot/x";
import type { BotConfig } from "./config";
import { chainLabel } from "./replies";
import type { BotStore } from "./store";

/**
 * One post a day from the bot's own account: what went through o1bot in the
 * last 24 hours (launches per chain, volume and trades, the most traded
 * token), read from the tables the board reads. A day with neither a launch
 * nor a trade gets no post. RECAP_ENABLED turns it on and RECAP_HOUR_UTC
 * says when; the day last handled is kept in the bot cursor table, so a
 * restart never posts twice and a failed post is retried a minute later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CURSOR_ID = "recap:last";
export const RECAP_POLL_MS = 60_000;
const CHAIN_ORDER: ChainKey[] = ["robinhood", "base", "arc"];

export type RecapFigures = {
  /** Live launches in the window, per chain. */
  launches: Partial<Record<ChainKey, number>>;
  /** Trades on o1bot tokens in the window. */
  trades: number;
  /** Their volume in dollars; null when no paired asset could be priced. */
  volumeUsd: number | null;
  /** The token with the largest dollar volume in the window. */
  top: { ticker: string; volumeUsd: number; changePct: number | null } | null;
};

type RecapDeps = { store: Pick<BotStore, "getCursor" | "setCursor">; x: Pick<XClient, "postTweet">; config: Pick<BotConfig, "siteUrl" | "dryRun"> };
type RecapCursor = { day: string; tweetId: string | null };

export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

const signedPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%`;

/** The post's text, or null when nothing happened in the window. */
export function recapText(f: RecapFigures, siteUrl: string): string | null {
  const total = CHAIN_ORDER.reduce((s, k) => s + (f.launches[k] ?? 0), 0);
  if (total === 0 && f.trades === 0) return null;
  const perChain = CHAIN_ORDER.filter((k) => (f.launches[k] ?? 0) > 0);
  const launches =
    total === 0
      ? "no new launches"
      : perChain.length === 1
        ? `${total} launch${total === 1 ? "" : "es"} on ${chainLabel(perChain[0])}`
        : `${total} launches (${perChain.map((k) => `${f.launches[k]} on ${chainLabel(k)}`).join(", ")})`;
  const trades =
    f.trades === 0 ? "no trades" : `${f.volumeUsd === null ? "" : `${formatUsd(f.volumeUsd)} traded across `}${f.trades.toLocaleString("en-US")} trade${f.trades === 1 ? "" : "s"}`;
  const top = f.top && f.top.volumeUsd > 0 ? `Most traded: $${f.top.ticker}, ${formatUsd(f.top.volumeUsd)}${f.top.changePct === null ? "" : ` (${signedPct(f.top.changePct)})`}. ` : "";
  return `o1bot, last 24h: ${launches}, ${trades}. ${top}Board: ${siteUrl}`;
}

/** Price change of a token over the window: the latest swap against the last one before the window (or the earliest ever). */
async function priceChangePct(token: string, since: Date): Promise<number | null> {
  const order = [{ timestamp: "desc" as const }, { logIndex: "desc" as const }];
  const [last, before] = await Promise.all([
    db().swap.findFirst({ where: { token }, orderBy: order, select: { priceQuote: true } }),
    db().swap.findFirst({ where: { token, timestamp: { lt: since } }, orderBy: order, select: { priceQuote: true } }),
  ]);
  const base = before ?? (await db().swap.findFirst({ where: { token }, orderBy: [{ timestamp: "asc" }, { logIndex: "asc" }], select: { priceQuote: true } }));
  if (!last || !base) return null;
  const a = Number(base.priceQuote.toString());
  const b = Number(last.priceQuote.toString());
  return a > 0 ? ((b - a) / a) * 100 : null;
}

/** The last 24 hours from the pools and swaps the indexer keeps. */
export async function collectRecapFigures(now: Date = new Date()): Promise<RecapFigures> {
  const since = new Date(now.getTime() - DAY_MS);
  const pools = await db().pool.findMany({ where: { source: "BOT" }, select: { token: true, chainId: true, symbol: true, quoteAddress: true, quoteDecimals: true, launchedAt: true } });
  const launches: Partial<Record<ChainKey, number>> = {};
  for (const p of pools) {
    if (p.launchedAt < since) continue;
    const key = chainKeyById(p.chainId);
    if (key) launches[key] = (launches[key] ?? 0) + 1;
  }
  if (pools.length === 0) return { launches, trades: 0, volumeUsd: null, top: null };
  const day = await db().swap.groupBy({ by: ["token"], where: { token: { in: pools.map((p) => p.token) }, timestamp: { gte: since } }, _sum: { amountQuote: true }, _count: { _all: true } });
  let trades = 0;
  let volumeUsd: number | null = null;
  let top: { token: string; ticker: string; volumeUsd: number } | null = null;
  for (const row of day) {
    const p = pools.find((x) => x.token === row.token);
    if (!p) continue;
    trades += row._count._all;
    const quote = Number(row._sum.amountQuote?.toString() ?? "0") / 10 ** p.quoteDecimals;
    const px = await quoteUsd(p.quoteAddress, p.quoteDecimals, chainKeyById(p.chainId) ?? "robinhood").catch(() => null);
    if (px === null) continue;
    const usd = quote * px;
    volumeUsd = (volumeUsd ?? 0) + usd;
    if (!top || usd > top.volumeUsd) top = { token: p.token, ticker: p.symbol, volumeUsd: usd };
  }
  return { launches, trades, volumeUsd, top: top ? { ticker: top.ticker, volumeUsd: top.volumeUsd, changePct: await priceChangePct(top.token, since) } : null };
}

/** Due once per UTC day, from the configured hour on; `lastDay` is the day last handled (posted or skipped). */
export function recapDue(now: Date, hourUtc: number, lastDay: string | null): boolean {
  return now.getUTCHours() >= hourUtc && dayOf(now) !== lastDay;
}

async function lastHandledDay(store: RecapDeps["store"]): Promise<string | null> {
  const raw = await store.getCursor(CURSOR_ID);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as RecapCursor).day ?? null;
  } catch {
    return null;
  }
}

export type RecapOutcome = { posted: boolean; text: string | null; reason: "not due" | "quiet day" | "dry run" | "posted" };

/** One check: post today's recap if it is due and there is something to say. */
export async function runRecapOnce(deps: RecapDeps, opts: { hourUtc: number; now?: Date; collect?: (now: Date) => Promise<RecapFigures> }): Promise<RecapOutcome> {
  const now = opts.now ?? new Date();
  if (!recapDue(now, opts.hourUtc, await lastHandledDay(deps.store))) return { posted: false, text: null, reason: "not due" };
  const figures = await (opts.collect ?? collectRecapFigures)(now);
  const text = recapText(figures, deps.config.siteUrl);
  const remember = (tweetId: string | null) => deps.store.setCursor(CURSOR_ID, JSON.stringify({ day: dayOf(now), tweetId } satisfies RecapCursor));
  if (!text) {
    await remember(null);
    logger.info({ day: dayOf(now) }, "daily recap skipped: nothing happened");
    return { posted: false, text: null, reason: "quiet day" };
  }
  if (deps.config.dryRun) {
    await remember("dry-run");
    logger.info({ text }, "dry run: daily recap not posted");
    return { posted: false, text, reason: "dry run" };
  }
  const tweetId = await deps.x.postTweet(text);
  await remember(tweetId);
  logger.info({ tweetId, text }, "daily recap posted");
  return { posted: true, text, reason: "posted" };
}

/** Check every minute; a failed post is logged and tried again on the next tick. */
export function startRecapPolling(deps: RecapDeps, opts: { enabled: boolean; hourUtc: number; intervalMs?: number }): { stop(): Promise<void> } {
  if (!opts.enabled) return { stop: async () => {} };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runRecapOnce(deps, { hourUtc: opts.hourUtc });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "daily recap failed; trying again next minute");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? RECAP_POLL_MS);
  void tick();
  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}
