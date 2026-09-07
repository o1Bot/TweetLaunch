import { normalizeHandle } from "@o1bot/shared";
import type { MissingField, ParseOutput } from "./schema";

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
  /** null = not stated; v1 treats that as Robinhood. */
  chain: "robinhood" | null;
  /** Decimal ETH string exactly as the user wrote it, or null. */
  devBuyNative: string | null;
  feesToHandle: string | null;
  imageFromTweet: boolean;
  language: string;
  reason: string;
};

export type ParseResult =
  | LaunchCommand
  | { kind: "clarify"; question: string; missing: MissingField[]; language: string; reason: string }
  | { kind: "unsupported_chain"; chain: "base" | "other"; language: string; reason: string }
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
};

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

export function normalizeParseOutput(raw: ParseOutput, input: { hasImage: boolean }): ParseResult {
  const language = raw.language.trim() || "en";
  const reason = raw.reason.trim();

  if (raw.kind === "ignore") return { kind: "ignore", language, reason };

  if (raw.kind === "help") {
    const reply = (raw.reply ?? "").trim().slice(0, REPLY_MAX);
    if (!reply) return { kind: "ignore", language, reason: `help without reply text (${reason})` };
    return { kind: "help", reply, language, reason };
  }

  // launch or clarify: re-derive the missing list from the values themselves.
  const missing = new Set<MissingField>(raw.kind === "clarify" ? raw.missing : []);
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

  if (raw.chain === "base" || raw.chain === "other") {
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
    language,
    reason,
  };
}
