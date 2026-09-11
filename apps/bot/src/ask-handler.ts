import { getAddress, type Address } from "viem";
import type { AskCommand, AskTopic } from "@o1bot/parser";
import { formatPct, formatUsd } from "@o1bot/market";
import type { ChainKey } from "@o1bot/shared";
import { stripLeadingMentions } from "@o1bot/x";
import type { AskData, PlatformStats, TokenSummary, UserLaunches, UserTrades, WalletSummary } from "./ask-data";
import type { MentionContext, PipelineOutcome } from "./pipeline";
import { chainLabel, replies, tokenPageUrl } from "./replies";

/**
 * The question branch of the pipeline. A data question is answered in two
 * steps: look the figures up (`AskData`), write them down as English facts,
 * then let the model phrase the answer in the post's language (`compose`).
 * The facts also produce an English template, used when the model's text
 * cannot be trusted or is not available (tests, dry runs without a key).
 * Questions about the poster's own account need a linked wallet.
 */

const PERSONAL: ReadonlySet<AskTopic> = new Set(["wallet", "launches", "fees", "trades"]);
const TOP_N = 3;

export type Built = { facts: string; fallback: string; safe?: string };

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `digits` significant digits in plain notation (a post never says "3.2e-7"), trailing zeros dropped. */
export function sig(n: number, digits: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.min(18, Math.max(0, digits - 1 - exp));
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

/** Dollar figures: K/M/B above a thousand, cents above a dollar, three significant digits below. */
export const money = (n: number | null): string => (n === null ? "unknown" : Math.abs(n) >= 1 ? formatUsd(n) : `$${sig(n, 3)}`);
export const pct = (n: number | null): string => (n === null ? "n/a" : formatPct(n));
export const count = (n: number): string => n.toLocaleString("en-US");
/** A token's price in its paired asset, plain notation. */
export const price = (n: number | null, unit: string): string => (n === null ? "no trade yet" : `${Math.abs(n) >= 1 ? n.toFixed(4).replace(/\.?0+$/, "") : sig(n, 3)} ${unit}`);

/** Native and quote amounts: up to `decimals` places without trailing zeros; dust keeps two significant digits. */
export function amount(value: string | number, decimals = 4): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 10 ** -decimals) return n.toFixed(decimals).replace(/\.?0+$/, "");
  return sig(n, 2);
}

/** Token balances, compact: 1.23M, 45.6K, 12.5. */
export function tokenAmount(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return amount(n, 2);
}

export function ago(date: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

const chainName = (key: ChainKey) => chainLabel(key);

function statusWord(status: string): string {
  if (status === "CONFIRMED" || status === "REPLIED") return "confirmed";
  if (status === "FAILED") return "failed";
  if (status === "DRY_RUN") return "dry run";
  return "pending";
}

export function statsAnswer(s: PlatformStats, scope: ChainKey | null, siteUrl: string, now: Date): Built {
  // Without a single trade the volume is a plain zero, not "unknown".
  const volume = (n: number | null) => (n === null && s.trades === 0 ? "$0" : money(n));
  const lines = [
    `Subject: o1bot.exchange statistics${scope ? ` on ${chainName(scope)}` : ""}: tokens launched through the bot and trading on their pools.`,
    scope
      ? `Tokens launched through o1bot on ${chainName(scope)}: ${count(s.launches.total)}.`
      : `Tokens launched through o1bot: ${count(s.launches.total)} in total (${count(s.launches.robinhood)} on Robinhood Chain, ${count(s.launches.base)} on Base).`,
    `Trades on those tokens since launch: ${count(s.trades)}.`,
    `Trading volume, last 24 hours: ${volume(s.volume24hUsd)}.`,
    `Trading volume, all time: ${volume(s.volumeAllUsd)}.`,
    s.latest ? `Newest launch: $${s.latest.symbol} on ${chainName(s.latest.chain)}, ${ago(s.latest.launchedAt, now)}.` : `No token has been launched through o1bot${scope ? ` on ${chainName(scope)}` : ""} yet.`,
    `Board with every token, live numbers: ${siteUrl}`,
  ];
  const fallback = replies.askStats({
    total: s.launches.total,
    robinhood: s.launches.robinhood,
    base: s.launches.base,
    scope: scope ? chainName(scope) : null,
    vol24: volume(s.volume24hUsd),
    volAll: volume(s.volumeAllUsd),
    trades: count(s.trades),
    siteUrl,
  });
  return { facts: lines.join("\n"), fallback };
}

export function topAnswer(rows: TokenSummary[], scope: ChainKey | null, siteUrl: string): Built {
  if (rows.length === 0) {
    return { facts: `Subject: the most traded tokens launched through o1bot.\nNo token has been launched through o1bot${scope ? ` on ${chainName(scope)}` : ""} yet, so there is nothing to rank.\nBoard: ${siteUrl}`, fallback: replies.askNoTokens(siteUrl) };
  }
  const lines = [
    `Subject: the most traded tokens launched through o1bot in the last 24 hours${scope ? ` on ${chainName(scope)}` : ""}, best first.`,
    ...rows.map((t, i) => `${i + 1}) $${t.symbol} (${t.name}) on ${chainName(t.chain)}: ${money(t.volume24hUsd)} volume 24h, ${pct(t.change24hPct)} in 24h, price ${money(t.priceUsd)}, market cap ${money(t.mcapUsd)}. Page: ${tokenPageUrl(siteUrl, t.token)}`),
    `Board with every token: ${siteUrl}`,
  ];
  return { facts: lines.join("\n"), fallback: replies.askTop(rows.map((t) => ({ ticker: t.symbol, vol24: money(t.volume24hUsd), change: pct(t.change24hPct) })), siteUrl) };
}

export function tokenAnswer(asked: string, found: TokenSummary[], siteUrl: string, now: Date): Built {
  if (found.length === 0) {
    return {
      facts: `Subject: $${asked} was asked about.\nNo token with ticker or address ${asked} was launched through o1bot, so the bot has no numbers for it.\nBoard with every token launched through o1bot: ${siteUrl}`,
      fallback: replies.askTokenUnknown(asked, siteUrl),
    };
  }
  if (found.length > 1) {
    const lines = [
      `Subject: more than one token with ticker $${asked} was launched through o1bot; the poster must say which one by address.`,
      ...found.map((t) => `$${t.symbol} (${t.name}) on ${chainName(t.chain)}, address ${t.token}: ${money(t.volume24hUsd)} volume 24h, launched ${ago(t.launchedAt, now)}. Page: ${tokenPageUrl(siteUrl, t.token)}`),
      "Ask again with the address to get one token's full numbers.",
    ];
    const fb = replies.askTokenAmbiguous(asked, found.map((t) => ({ name: t.name, token: t.token, vol24: money(t.volume24hUsd) })));
    return { facts: lines.join("\n"), fallback: fb.text, safe: fb.safe };
  }
  const t = found[0]!;
  const page = tokenPageUrl(siteUrl, t.token);
  const lines = [
    `Subject: $${t.symbol}, a token launched through o1bot.`,
    `$${t.symbol} (${t.name}) on ${chainName(t.chain)}, paired with ${t.quoteSymbol}, launched ${ago(t.launchedAt, now)}${t.creatorHandle ? ` by @${t.creatorHandle}` : ""}.`,
    `Price: ${price(t.priceQuote, t.quoteSymbol)} per token (${money(t.priceUsd)}). Change, last 24 hours: ${pct(t.change24hPct)}.`,
    `Volume, last 24 hours: ${money(t.volume24hUsd)}. Volume, all time: ${money(t.volumeAllUsd)}. Market cap: ${money(t.mcapUsd)}.`,
    `Trades since launch: ${count(t.trades)}. Holders: ${t.holders === null ? "unknown" : count(t.holders)}.`,
    `Creator's fee share earned so far: ${amount(t.creatorFeesQuote)} ${t.quoteSymbol}.`,
    `Contract address: ${t.token}`,
    `Token page with chart, trades and swap: ${page}`,
  ];
  const fallback = replies.askToken({
    ticker: t.symbol,
    name: t.name,
    chain: chainName(t.chain),
    price: price(t.priceQuote, t.quoteSymbol),
    priceUsd: money(t.priceUsd),
    change: pct(t.change24hPct),
    vol24: money(t.volume24hUsd),
    mcap: money(t.mcapUsd),
    holders: t.holders === null ? null : count(t.holders),
    creator: t.creatorHandle,
    page,
  });
  return { facts: lines.join("\n"), fallback };
}

export function walletAnswer(w: WalletSummary, handle: string, siteUrl: string): Built {
  const eth = w.eth.map((e) => `${amount(e.eth)} on ${chainName(e.chain)}${e.usd === null ? "" : ` (${money(e.usd)})`}`).join(", ");
  const quotes = w.quotes.map((q) => `${amount(q.balance, 2)} ${q.symbol} on ${chainName(q.chain)}${q.usd === null ? "" : ` (${money(q.usd)})`}`).join(", ");
  const tokens = w.tokens.map((t) => `$${t.symbol} ${tokenAmount(t.balance)}${t.usd === null ? "" : ` (${money(t.usd)})`} on ${chainName(t.chain)}`).join(", ");
  const tokensUsd = w.tokens.some((t) => t.usd !== null) ? w.tokens.reduce((s, t) => s + (t.usd ?? 0), 0) : null;
  const fees = w.feesOwed.map((f) => `${amount(f.balance)} ${f.symbol} on ${chainName(f.chain)}${f.usd === null ? "" : ` (${money(f.usd)})`}`).join(", ");
  const lines = [
    `Subject: the wallet linked to @${handle} on o1bot, which is the poster's own wallet.`,
    `Wallet address (the same on every chain): ${w.address}`,
    `ETH: ${eth || "none read"}.`,
    quotes ? `Stable and paired assets: ${quotes}.` : "Stable and paired assets: none.",
    w.tokensCount > 0 ? `o1bot tokens held: ${count(w.tokensCount)}${tokensUsd === null ? "" : `, about ${money(tokensUsd)} together`}${w.tokensCount > w.tokens.length ? `, the largest ${w.tokens.length}` : ""}: ${tokens}.` : "o1bot tokens held: none.",
    fees ? `Creator fees claimable in o1's escrow: ${fees}.` : "Creator fees claimable in o1's escrow: none.",
    w.totalUsd === null ? "Total value: unknown (no price for some of it)." : `Total value of what is listed: about ${money(w.totalUsd)}.`,
    "To deposit, send ETH on Robinhood Chain (or Base) to the wallet address above.",
    `Profile with balances, deposit and fee claims: ${siteUrl}/me`,
  ];
  // The template keeps the figures and drops the dollar values; the facts above carry both.
  const fb = replies.askWallet({
    address: w.address,
    eth: w.eth.map((e) => `${amount(e.eth)} on ${chainName(e.chain)}`).join(", ") || "0",
    quotes: w.quotes.map((q) => `${amount(q.balance, 2)} ${q.symbol}`).join(", ") || null,
    tokens: w.tokensCount > 0 ? `${count(w.tokensCount)} o1bot ${w.tokensCount === 1 ? "token" : "tokens"} (${w.tokens.map((t) => `$${t.symbol} ${tokenAmount(t.balance)}`).join(", ")})` : null,
    fees: fees ? `claimable fees ${w.feesOwed.map((f) => `${amount(f.balance)} ${f.symbol}`).join(", ")}` : null,
    siteUrl,
  });
  return { facts: lines.join("\n"), fallback: fb.text, safe: fb.safe };
}

export function launchesAnswer(l: UserLaunches, handle: string, siteUrl: string, now: Date): Built {
  const detail = (r: UserLaunches["live"][number]) =>
    `$${r.ticker} (${r.name}) on ${chainName(r.chain)}, launched ${ago(r.createdAt, now)}: price ${money(r.priceUsd)}, ${pct(r.change24hPct)} in 24h, ${money(r.volumeAllUsd)} volume all time, creator fees earned ${r.creatorFeesQuote === null ? "unknown" : `${amount(r.creatorFeesQuote)} ${r.quoteSymbol}`}${r.creatorFeesUsd === null ? "" : ` (${money(r.creatorFeesUsd)})`}. Page: ${r.token ? tokenPageUrl(siteUrl, r.token) : siteUrl}`;
  const lines = [
    `Subject: tokens @${handle} launched through o1bot.`,
    `Launches: ${count(l.total)} attempted, ${count(l.live.length)} live on chain, ${count(l.pending)} pending, ${count(l.failed)} failed.`,
    ...(l.live.length ? l.live.map(detail) : ["No live launch yet: post the launch command to make the first."]),
    `Profile with every launch: ${siteUrl}/me`,
  ];
  const short = l.live.slice(0, 3).map((r) => `$${r.ticker} ${money(r.volumeAllUsd)} volume, ${r.creatorFeesQuote === null ? "fees unknown" : `${amount(r.creatorFeesQuote)} ${r.quoteSymbol} fees`}`);
  return { facts: lines.join("\n"), fallback: replies.askLaunches({ live: l.live.length, total: l.total, lines: short, siteUrl }) };
}

export function feesAnswer(w: WalletSummary, l: UserLaunches, handle: string, siteUrl: string): Built {
  const claimable = w.feesOwed.map((f) => `${amount(f.balance)} ${f.symbol} on ${chainName(f.chain)}${f.usd === null ? "" : ` (${money(f.usd)})`}`).join(", ");
  const earnedRows = l.live.filter((r) => r.creatorFeesQuote !== null && r.creatorFeesQuote > 0);
  const earned = earnedRows.map((r) => `$${r.ticker} ${amount(r.creatorFeesQuote!)} ${r.quoteSymbol}${r.creatorFeesUsd === null ? "" : ` (${money(r.creatorFeesUsd)})`}`).join(", ");
  const earnedUsd = earnedRows.some((r) => r.creatorFeesUsd !== null) ? earnedRows.reduce((s, r) => s + (r.creatorFeesUsd ?? 0), 0) : null;
  const lines = [
    `Subject: creator fees of @${handle} from launches through o1bot.`,
    claimable ? `Claimable now in o1's escrow: ${claimable}.` : "Claimable now in o1's escrow: nothing yet.",
    earned ? `Earned so far (the creator's share, half of o1's 1% swap fee), per token: ${earned}${earnedUsd === null ? "" : `; about ${money(earnedUsd)} together`}.` : l.live.length ? "Earned so far: nothing yet, no trades on those tokens." : "Earned so far: nothing, no live launch from this account yet.",
    "Fees accrue in the paired asset of each token and are claimed by the creator's own wallet, which needs a little ETH for gas.",
    `Claim and history: ${siteUrl}/me`,
  ];
  return { facts: lines.join("\n"), fallback: replies.askFees({ claimable: claimable || null, earned: earned || null, siteUrl }) };
}

export function tradesAnswer(t: UserTrades, handle: string, siteUrl: string, now: Date): Built {
  const line = (r: UserTrades["recent"][number]) =>
    r.side === "BUY"
      ? `bought ${r.amountOut ? `${tokenAmount(r.amountOut)} $${r.tokenSymbol}` : `$${r.tokenSymbol}`} for ${amount(r.amountIn)} ${r.quoteSymbol}, ${ago(r.createdAt, now)} (${statusWord(r.status)})`
      : `sold ${tokenAmount(r.amountIn)} $${r.tokenSymbol}${r.amountOut ? ` for ${amount(r.amountOut)} ${r.quoteSymbol}` : ""}, ${ago(r.createdAt, now)} (${statusWord(r.status)})`;
  const lines = [
    `Subject: trades @${handle} made from posts through o1bot.`,
    `Trades from posts so far: ${count(t.total)}.`,
    ...(t.recent.length ? [`Most recent first: ${t.recent.map(line).join("; ")}.`] : ["No trade from a post yet. Trading from posts must be turned on at the profile first."]),
    `History with transaction links: ${siteUrl}/me`,
  ];
  return { facts: lines.join("\n"), fallback: replies.askTrades({ total: t.total, lines: t.recent.slice(0, 2).map(line), siteUrl }) };
}

export type AnswerContext = { askData: AskData; siteUrl: string; wallet: Address | null; xUserId: string; handle: string; now: Date };

export async function buildAnswer(cmd: AskCommand, ctx: AnswerContext): Promise<Built> {
  const { askData, siteUrl, now } = ctx;
  switch (cmd.topic) {
    case "stats":
      return statsAnswer(await askData.platformStats(cmd.chain), cmd.chain, siteUrl, now);
    case "top":
      return topAnswer(await askData.topTokens(cmd.chain, TOP_N), cmd.chain, siteUrl);
    case "token": {
      const asked = cmd.tokenAddress ?? cmd.ticker ?? "";
      return tokenAnswer(asked, await askData.findTokens({ ticker: cmd.ticker, address: cmd.tokenAddress }), siteUrl, now);
    }
    case "wallet":
      return walletAnswer(await askData.wallet(ctx.wallet!, ctx.xUserId), ctx.handle, siteUrl);
    case "launches":
      return launchesAnswer(await askData.userLaunches(ctx.xUserId), ctx.handle, siteUrl, now);
    case "fees": {
      const [w, l] = await Promise.all([askData.wallet(ctx.wallet!, ctx.xUserId), askData.userLaunches(ctx.xUserId)]);
      return feesAnswer(w, l, ctx.handle, siteUrl);
    }
    case "trades":
      return tradesAnswer(await askData.userTrades(ctx.xUserId), ctx.handle, siteUrl, now);
  }
}

export async function handleAsk(cmd: AskCommand, ctx: MentionContext): Promise<PipelineOutcome> {
  const { mention, deps, now, log, reply, setMention } = ctx;
  const { store, config, askData } = deps;
  const siteUrl = config.siteUrl;

  // The poster's own numbers exist only for a linked account.
  let wallet: Address | null = null;
  if (PERSONAL.has(cmd.topic)) {
    const link = await deps.resolveLink(mention.authorId);
    if (!link.linked) {
      log.info({ reason: link.reason, topic: cmd.topic }, "poster is not registered; no personal numbers to show");
      const r = await reply(replies.askNotRegistered(siteUrl));
      await setMention("NOT_REGISTERED", { error: link.reason });
      return { outcome: "replied", kind: "not_registered", reply: r.posted || config.dryRun ? r.text : null };
    }
    wallet = getAddress(link.wallet.address);
  }

  let built: Built;
  try {
    built = await buildAnswer(cmd, { askData, siteUrl, wallet, xUserId: mention.authorId, handle: mention.authorHandle, now: now() });
  } catch (err) {
    const error = `ask ${cmd.topic}: ${errMsg(err)}`;
    log.error({ err: errMsg(err), topic: cmd.topic }, "could not look the answer up");
    const r = await reply(replies.askUnavailable(siteUrl));
    await setMention("FAILED", { error });
    return { outcome: "failed", error, reply: r.posted || config.dryRun ? r.text : null, launchId: null };
  }

  // The model phrases the answer from the facts; the English template stands in when it cannot.
  const prefs = await store.userPrefs(mention.authorId);
  const language = prefs.replyLanguage === "en" ? "en" : cmd.language;
  const composed = deps.compose ? await deps.compose({ post: stripLeadingMentions(mention.text), language, facts: built.facts, botHandle: config.botHandle, siteUrl }) : null;
  log.info({ topic: cmd.topic, composed: composed !== null }, "answering a question from the data");
  const r = composed ? await reply(composed, { raw: true, safe: built.safe }) : await reply(built.fallback, { safe: built.safe });
  await setMention("DONE");
  return { outcome: "replied", kind: "ask", reply: r.posted || config.dryRun ? r.text : null };
}
