import { DECIMAL_RE, FALLBACK_QUESTION, cleanSellPortion, type SellPortion } from "./normalize";
import type { MissingField, ParseOutput } from "./schema";

/**
 * Perp commands: a leveraged long or short on a Lighter market, or closing
 * one, always on the poster's own Lighter account. Like the rest of the
 * normaliser this is the only place that decides the command is well formed;
 * the model is told the rules, this enforces them.
 *
 * "long $BTC 10x with 500 usdc" reads as: side long, market BTC, leverage 10,
 * collateral 500 USDC. The position is collateral times leverage. Nothing is
 * ever assumed: an open without a leverage or without an amount is a
 * question back, not a default.
 */
export type PerpCommand = {
  kind: "perp";
  action: "open" | "close";
  /** Open only. */
  side: "long" | "short" | null;
  /** Lighter market symbol, uppercased, without $. The bot checks it against the live markets. */
  market: string;
  /** Open only: whole-number leverage as the user stated it. */
  leverage: number | null;
  /** Open only: collateral in USDC, a plain decimal string as written. */
  marginUsdc: string | null;
  /** Close only: how much of the position; all when the post names no portion. */
  closePortion: SellPortion | null;
  language: string;
  reason: string;
};

type Clarify = { kind: "clarify"; question: string; missing: MissingField[]; language: string; reason: string };

export const PERP_MISSING: ReadonlySet<MissingField> = new Set(["perp_side", "perp_market", "perp_amount", "perp_leverage"]);
/** Lighter symbols: BTC, 1000PEPE, EURUSD, SAMSUNGUSD, ANTHROPIC. */
export const PERP_MARKET_RE = /^[A-Z0-9]{1,15}$/;
/** No market offers more; the bot checks the market's own ceiling and the user's cap afterwards. */
export const PERP_LEVERAGE_MAX = 100;

export const isPerpSide = (side: ParseOutput["trade_side"]): side is "long" | "short" | "close" => side === "long" || side === "short" || side === "close";

/** Whether the model output is a perp command, or a question about one. */
export function isPerpIntent(raw: ParseOutput): boolean {
  if (raw.kind === "perp") return true;
  return raw.kind === "clarify" && (raw.missing.some((m) => PERP_MISSING.has(m)) || isPerpSide(raw.trade_side));
}

/** "10", "10x", "x10" → 10. Anything else (a range, a decimal, zero) is not a leverage. */
export function cleanPerpLeverage(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/^x\s*/, "").replace(/\s*x$/, "");
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= PERP_LEVERAGE_MAX ? n : null;
}

/**
 * The collateral for an open: "500", "500 usdc", "$500", "500 usd". USDC is
 * the only margin asset, so a dollar amount is the natural way to say it;
 * any other unit (ETH, BTC, contracts, a percentage) is unusable.
 */
export function cleanPerpMargin(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const s = raw.trim().replace(/,/g, ".");
  if (!s) return { ok: true, value: null };
  const m = s.match(/^\$?\s*(\d+(?:\.\d+)?|\.\d+)\s*(usdc|usd|dollars?|\$)?$/i);
  if (!m) return { ok: false };
  const value = m[1]!.startsWith(".") ? `0${m[1]}` : m[1]!;
  if (!DECIMAL_RE.test(value) || Number(value) <= 0) return { ok: false };
  return { ok: true, value };
}

function cleanMarket(raw: string | null): string | null {
  const t = (raw ?? "").trim().replace(/^\$/, "").toUpperCase();
  return t && PERP_MARKET_RE.test(t) ? t : null;
}

export function normalizePerp(raw: ParseOutput, language: string, reason: string): PerpCommand | Clarify {
  const missing = new Set<MissingField>(raw.kind === "clarify" ? raw.missing.filter((m) => PERP_MISSING.has(m)) : []);
  const side = isPerpSide(raw.trade_side) ? raw.trade_side : null;
  const market = cleanMarket(raw.ticker);

  if (!side) missing.add("perp_side");
  if (!market) missing.add("perp_market");

  let leverage: number | null = null;
  let marginUsdc: string | null = null;
  let closePortion: SellPortion | null = null;

  if (side === "close") {
    // No portion named means the whole position; a portion that cannot be read is a question.
    const stated = (raw.trade_amount ?? "").trim();
    const portion = stated ? cleanSellPortion(stated) : { ok: true as const, value: { kind: "all" } as SellPortion };
    if (!portion.ok || portion.value === null) missing.add("perp_amount");
    else closePortion = portion.value;
  } else if (side) {
    leverage = cleanPerpLeverage(raw.perp_leverage);
    const margin = cleanPerpMargin(raw.trade_amount);
    if (leverage === null) missing.add("perp_leverage");
    if (!margin.ok || margin.value === null) missing.add("perp_amount");
    else marginUsdc = margin.value;
  }

  if (missing.size > 0 || !side || !market) {
    const list = [...missing];
    const question = (raw.question ?? "").trim() || list.map((m) => FALLBACK_QUESTION[m]).join(" ");
    return { kind: "clarify", question, missing: list, language, reason };
  }

  return side === "close"
    ? { kind: "perp", action: "close", side: null, market, leverage: null, marginUsdc: null, closePortion, language, reason }
    : { kind: "perp", action: "open", side, market, leverage, marginUsdc, closePortion: null, language, reason };
}
