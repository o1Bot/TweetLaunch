import { isBridgeChainKey, normalizeHandle, type BridgeChainKey } from "@o1bot/shared";
import type { AskTopic, MissingField, ParseOutput } from "./schema";

/**
 * Deterministic post-processing of the model output. The model is told the
 * rules, but this layer enforces them: it is the only place that decides a
 * launch is well-formed. Pure, so it is unit-tested without the API.
 */

export type LaunchCommand = {
  kind: "launch";
  ticker: string;
  name: string;
  /** Pair symbol as normalised (validator checks it against the live factory). */
  pair: string;
  /** null = not stated, which means Robinhood; "base" only when the post says so. */
  chain: "robinhood" | "base" | null;
  /** Decimal ETH string exactly as the user wrote it, or null. */
  devBuyNative: string | null;
  feesToHandle: string | null;
  imageFromTweet: boolean;
  /** Metadata extras the user stated; the bot never invents them. */
  description: string | null;
  website: string | null;
  telegram: string | null;
  /** Project X handle (lowercase, no @) when the user named one; null = the poster's own account. */
  xHandle: string | null;
  language: string;
  reason: string;
};

export type SellPortion = { kind: "all" } | { kind: "percent"; value: number };

/** A buy or sell from a post, always for the poster's own wallet. Ticker or address; the pipeline resolves it. */
export type TradeCommand = {
  kind: "trade";
  side: "buy" | "sell";
  /** Ticker without $, uppercased; null when the user gave an address. */
  ticker: string | null;
  /** 0x address exactly as written (case not normalised here); null when the user gave a ticker. */
  tokenAddress: string | null;
  /** Buys only: the amount to spend exactly as written, and the asset it is in (null = ETH). */
  amount: string | null;
  amountSymbol: string | null;
  /** Sells only. */
  sellPortion: SellPortion | null;
  /** Requested slippage in basis points, already bounded; null = the bot's default. */
  slippageBps: number | null;
  /** Bridge ETH from this chain into the wallet first; null = the ETH is already on Robinhood. */
  fromChain: BridgeChainKey | null;
  language: string;
  reason: string;
};

/** "bridge 0.1 ETH from base": ETH from the poster's wallet on another chain to the same wallet on Robinhood. */
export type BridgeCommand = {
  kind: "bridge";
  fromChain: BridgeChainKey;
  /** Decimal ETH string exactly as written. */
  amount: string;
  language: string;
  reason: string;
};

/**
 * A question the bot answers from its own data: platform statistics, a
 * token's market data, or the poster's own wallet, launches, fees or trades.
 * The figures are fetched after parsing; nothing here is a value to act on.
 */
export type AskCommand = {
  kind: "ask";
  topic: AskTopic;
  /** Topic token: ticker without $, uppercased; null when the user gave an address. */
  ticker: string | null;
  /** Topic token: 0x address exactly as written; null when the user gave a ticker. */
  tokenAddress: string | null;
  /** Chain the question is scoped to ("on base"); null = all chains, or the default where one is needed. */
  chain: "robinhood" | "base" | null;
  language: string;
  reason: string;
};

/** o1 caps descriptions at 2000 UTF-8 bytes; a post cannot exceed that, but the model output could. */
export const DESCRIPTION_MAX_BYTES = 2000;

export function cleanDescription(raw: string | null | undefined): string | null {
  const d = (raw ?? "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!d) return null;
  const bytes = Buffer.from(d, "utf8");
  return bytes.length <= DESCRIPTION_MAX_BYTES ? d : bytes.subarray(0, DESCRIPTION_MAX_BYTES).toString("utf8").replace(/�+$/, "");
}

/** Accept http(s) URLs only; anything else is dropped rather than guessed. */
export function cleanWebsite(raw: string | null | undefined): string | null {
  const w = (raw ?? "").trim();
  if (!w) return null;
  const withScheme = /^https?:\/\//i.test(w) ? w : `https://${w}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** t.me links stay as given; "@name" or "name" becomes https://t.me/name. */
export function cleanTelegram(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{3,64})\/?$/i);
  if (m) return `https://t.me/${m[1]}`;
  const handle = t.replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(handle) ? `https://t.me/${handle}` : null;
}

/** Handle from "@name", "name" or an x.com / twitter.com profile URL. */
export function cleanXHandle(raw: string | null | undefined): string | null {
  const x = (raw ?? "").trim();
  if (!x) return null;
  const m = x.match(/^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})\/?$/i);
  return normalizeHandle(m ? m[1]! : x);
}

export type ParseResult =
  | LaunchCommand
  | TradeCommand
  | BridgeCommand
  | AskCommand
  | { kind: "clarify"; question: string; missing: MissingField[]; language: string; reason: string }
  | { kind: "unsupported_chain"; chain: string; language: string; reason: string }
  | { kind: "help"; reply: string; language: string; reason: string }
  | { kind: "ignore"; language: string; reason: string };

export const TICKER_RE = /^[A-Z0-9]{1,11}$/;
export const NAME_MAX = 50;
export const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;
export const REPLY_MAX = 280;

const FALLBACK_QUESTION: Record<MissingField, string> = {
  ticker: "What ticker should the token have? Example: $RUGRAT",
  name: 'What is the token\'s name? Example: "Rugrat"',
  pair: "Which pair should it trade against? ETH, USDG or a stock token like NVDA",
  devbuy_amount: "How much ETH do you want for the dev buy? Example: devbuy 0.05",
  fees_to_handle: "Which X account should receive the creator fees? Example: fees to @alice",
  trade_side: "Buy or sell? Example: buy 0.05 ETH of $CAT",
  trade_token: "Which token? Give its ticker or address. Example: sell half of $CAT",
  trade_amount: "How much? For a buy give the ETH amount, for a sell give all, half or a percentage. Example: buy 0.05 ETH of $CAT",
  bridge_chain: "From which chain? Base, Ethereum, Arbitrum or Optimism. Example: bridge 0.1 ETH from base",
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Slippage a post may ask for: 0.1% to 10%. */
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 1000;
const TRADE_MISSING: ReadonlySet<MissingField> = new Set(["trade_side", "trade_token", "trade_amount"]);
const BRIDGE_MISSING: ReadonlySet<MissingField> = new Set(["trade_amount", "bridge_chain"]);

function normalizeBridge(raw: ParseOutput, language: string, reason: string): ParseResult {
  const missing = new Set<MissingField>(raw.kind === "clarify" ? raw.missing.filter((m) => BRIDGE_MISSING.has(m)) : []);
  const amount = cleanTradeAmount(raw.trade_amount);
  if (!amount.ok || amount.value === null || (amount.symbol !== null && amount.symbol !== "ETH")) missing.add("trade_amount");
  if (raw.chain === "other") return { kind: "unsupported_chain", chain: "other", language, reason };
  const fromChain = raw.chain && isBridgeChainKey(raw.chain) ? raw.chain : null;
  if (!fromChain) missing.add("bridge_chain");
  if (missing.size > 0) {
    const list = [...missing];
    const question = (raw.question ?? "").trim() || list.map((m) => FALLBACK_QUESTION[m]).join(" ");
    return { kind: "clarify", question, missing: list, language, reason };
  }
  return { kind: "bridge", fromChain: fromChain!, amount: amount.ok ? amount.value! : "0", language, reason };
}

export function cleanSellPortion(raw: string | null | undefined): { ok: true; value: SellPortion | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const s = raw.trim().toLowerCase().replace(/\s*(%|percent|pct)\s*$/, "").replace(/,/g, ".").trim();
  if (!s) return { ok: true, value: null };
  if (["all", "everything", "max", "100"].includes(s)) return { ok: true, value: { kind: "all" } };
  if (s === "half") return { ok: true, value: { kind: "percent", value: 50 } };
  if (s === "quarter") return { ok: true, value: { kind: "percent", value: 25 } };
  if (!DECIMAL_RE.test(s)) return { ok: false };
  const n = Number(s);
  if (!(n > 0 && n <= 100)) return { ok: false };
  return { ok: true, value: n === 100 ? { kind: "all" } : { kind: "percent", value: n } };
}

/** Percent string → bounded basis points; anything unusable is dropped (the bot's default applies). */
export function cleanSlippage(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim().replace(/\s*(%|percent|pct)\s*$/, "").replace(/,/g, ".");
  if (!s || !DECIMAL_RE.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  if (!Number.isFinite(bps) || bps <= 0) return null;
  return Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, bps));
}

export type TradeAmount = { ok: true; value: string | null; symbol: string | null } | { ok: false };

/** "0.05", "0.05 ETH", "5 NVDA" → amount and asset; anything else (USD, %, tokens) is unusable. */
export function cleanTradeAmount(raw: string | null | undefined): TradeAmount {
  if (raw === null || raw === undefined) return { ok: true, value: null, symbol: null };
  const s = raw.trim().replace(/,/g, ".");
  if (!s) return { ok: true, value: null, symbol: null };
  const m = s.match(/^(\d+(?:\.\d+)?|\.\d+)\s*\$?([A-Za-z]{1,11})?$/);
  if (!m) return { ok: false };
  const value = m[1]!.startsWith(".") ? `0${m[1]}` : m[1]!;
  if (!DECIMAL_RE.test(value) || Number(value) <= 0) return { ok: false };
  let symbol = m[2] ? m[2].toUpperCase() : null;
  if (symbol === "ETHER" || symbol === "ETHEREUM") symbol = "ETH";
  return { ok: true, value, symbol };
}

function normalizeTrade(raw: ParseOutput, language: string, reason: string): ParseResult {
  const missing = new Set<MissingField>(raw.kind === "clarify" ? raw.missing.filter((m) => TRADE_MISSING.has(m)) : []);
  const side = raw.trade_side;
  const tokenRaw = (raw.ticker ?? "").trim();
  const tokenAddress = ADDRESS_RE.test(tokenRaw) ? tokenRaw : null;
  const ticker = tokenAddress ? null : cleanTicker(tokenRaw || null);
  const amount: TradeAmount = side === "buy" ? cleanTradeAmount(raw.trade_amount) : { ok: true, value: null, symbol: null };
  const portion = side === "sell" ? cleanSellPortion(raw.trade_amount) : { ok: true as const, value: null };

  if (!side) missing.add("trade_side");
  if (!tokenAddress && (!ticker || !TICKER_RE.test(ticker))) missing.add("trade_token");
  if (side === "buy" && (!amount.ok || amount.value === null)) missing.add("trade_amount");
  if (side === "sell" && (!portion.ok || portion.value === null)) missing.add("trade_amount");

  if (missing.size > 0) {
    const list = [...missing];
    const question = (raw.question ?? "").trim() || list.map((m) => FALLBACK_QUESTION[m]).join(" ");
    return { kind: "clarify", question, missing: list, language, reason };
  }
  // "from base": bridge first. Any other named chain is one the bot cannot bridge from.
  if (raw.chain === "other") return { kind: "unsupported_chain", chain: "other", language, reason };
  const fromChain = raw.chain && isBridgeChainKey(raw.chain) ? raw.chain : null;
  return {
    kind: "trade",
    side: side!,
    ticker,
    tokenAddress,
    amount: side === "buy" && amount.ok ? amount.value : null,
    amountSymbol: side === "buy" && amount.ok ? amount.symbol : null,
    sellPortion: side === "sell" && portion.ok ? portion.value : null,
    slippageBps: cleanSlippage(raw.trade_slippage_pct),
    fromChain,
    language,
    reason,
  };
}

/** Which token was asked about? "Which token?" is asked when a token question names none. */
export const ASK_TOKEN_QUESTION = "Which token do you mean? Give its ticker or address, for example: how is $CAT doing?";

function normalizeAsk(raw: ParseOutput, language: string, reason: string): ParseResult {
  // The model said "ask" without a subject: treat it like any other question.
  if (raw.topic === "none") {
    const reply = oneLinkOnly((raw.reply ?? "").trim()).slice(0, REPLY_MAX);
    return reply ? { kind: "help", reply, language, reason } : { kind: "ignore", language, reason: `ask without topic (${reason})` };
  }
  const tokenRaw = (raw.ticker ?? "").trim();
  const tokenAddress = ADDRESS_RE.test(tokenRaw) ? tokenRaw : null;
  const ticker = tokenAddress ? null : cleanTicker(tokenRaw || null);
  if (raw.topic === "token" && !tokenAddress && (!ticker || !TICKER_RE.test(ticker))) {
    return { kind: "clarify", question: (raw.question ?? "").trim() || ASK_TOKEN_QUESTION, missing: ["trade_token"], language, reason };
  }
  const chain = raw.chain === "robinhood" || raw.chain === "base" ? raw.chain : null;
  return { kind: "ask", topic: raw.topic, ticker: raw.topic === "token" ? ticker : null, tokenAddress: raw.topic === "token" ? tokenAddress : null, chain, language, reason };
}

function cleanTicker(raw: string | null): string | null {
  const t = (raw ?? "").trim().replace(/^\$/, "").toUpperCase();
  return t ? t : null;
}

function cleanName(raw: string | null): string | null {
  const n = (raw ?? "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  return n ? n : null;
}

function cleanPair(raw: string | null): string | null {
  const p = (raw ?? "").trim().replace(/^\$/, "").toUpperCase();
  return p ? p : null;
}

function cleanAmount(raw: string | null): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const a = raw.trim().replace(/\s*eth$/i, "").replace(/,/g, ".");
  if (!a) return { ok: true, value: null };
  if (!DECIMAL_RE.test(a) || Number(a) <= 0) return { ok: false };
  return { ok: true, value: a };
}

/** X charges per link and the prompt allows one; when the model adds a second, drop it (and a leading "See"). */
export function oneLinkOnly(reply: string): string {
  const urls = reply.match(/https?:\/\/[^\s)]+/g) ?? [];
  if (urls.length <= 1) return reply;
  let out = reply;
  for (const url of urls.slice(1)) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\s*(?:\\(?\\b(?:see|docs|more)\\b:?\\s*)?${escaped}\\)?[.,;:]?`, "i"), "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

export function normalizeParseOutput(raw: ParseOutput, input: { hasImage: boolean }): ParseResult {
  const language = raw.language.trim() || "en";
  const reason = raw.reason.trim();

  if (raw.kind === "ignore") return { kind: "ignore", language, reason };

  if (raw.kind === "help") {
    const reply = oneLinkOnly((raw.reply ?? "").trim()).slice(0, REPLY_MAX);
    if (!reply) return { kind: "ignore", language, reason: `help without reply text (${reason})` };
    return { kind: "help", reply, language, reason };
  }

  // A data question: the topic decides, the bot fetches the figures afterwards.
  if (raw.kind === "ask") return normalizeAsk(raw, language, reason);

  // A bridge, or a clarify about one, is decided before trades: it has no side.
  const bridgeIntent = raw.kind === "bridge" || (raw.kind === "clarify" && raw.missing.includes("bridge_chain"));
  if (bridgeIntent) return normalizeBridge(raw, language, reason);
  // A trade, or a clarify about one: the trade fields decide, never the launch fields.
  const tradeIntent = raw.kind === "trade" || (raw.kind === "clarify" && (raw.missing.some((m) => TRADE_MISSING.has(m)) || raw.trade_side !== null));
  if (tradeIntent) return normalizeTrade(raw, language, reason);

  // launch or clarify: re-derive the missing list from the values themselves.
  const missing = new Set<MissingField>(raw.kind === "clarify" ? raw.missing.filter((m) => !TRADE_MISSING.has(m) && !BRIDGE_MISSING.has(m)) : []);
  const ticker = cleanTicker(raw.ticker);
  const name = cleanName(raw.name);
  const pair = cleanPair(raw.pair);
  const amount = cleanAmount(raw.devbuy_native);
  const feesRaw = (raw.fees_to_handle ?? "").trim();
  const feesTo = feesRaw ? normalizeHandle(feesRaw) : null;

  if (!ticker || !TICKER_RE.test(ticker)) missing.add("ticker");
  if (!name || [...name].length > NAME_MAX) missing.add("name");
  if (!pair) missing.add("pair");
  if (!amount.ok) missing.add("devbuy_amount");
  if (feesRaw && !feesTo) missing.add("fees_to_handle");

  if (missing.size > 0) {
    const list = [...missing];
    const question = (raw.question ?? "").trim() || list.map((m) => FALLBACK_QUESTION[m]).join(" ");
    return { kind: "clarify", question, missing: list, language, reason };
  }

  if (raw.chain !== null && raw.chain !== "robinhood" && raw.chain !== "base") {
    return { kind: "unsupported_chain", chain: raw.chain, language, reason };
  }

  return {
    kind: "launch",
    ticker: ticker!,
    name: name!,
    pair: pair!,
    chain: raw.chain,
    devBuyNative: amount.ok ? amount.value : null,
    feesToHandle: feesTo,
    imageFromTweet: input.hasImage,
    description: cleanDescription(raw.description),
    website: cleanWebsite(raw.website),
    telegram: cleanTelegram(raw.telegram),
    xHandle: cleanXHandle(raw.x_handle),
    language,
    reason,
  };
}
