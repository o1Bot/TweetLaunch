// Lighter order book stream client (RH instance).
//
// Format verified live 2026-07-29: subscribe {"type":"subscribe","channel":"order_book/1"},
// the snapshot arrives as "subscribed/order_book", deltas as "update/order_book" where
// size "0.00000" means the level is removed, plus a monotonic `offset` for gap detection.
//
// §5 rule: book state must NOT go into React state per tick — consumers receive a
// reference via callback and render on their own throttled tick.

import type { TapeTrade } from "./candles";

declare const process: { env: Record<string, string | undefined> } | undefined;

export const DEFAULT_STREAM_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIGHTER_WS) ||
  "wss://mainnet.zklighter.elliot.ai/stream";

export interface BookLevel {
  price: string;
  size: string;
}

export interface OrderBookState {
  /** Descending from the highest price. */
  bids: BookLevel[];
  /** Ascending from the lowest price. */
  asks: BookLevel[];
  offset: number;
  lastUpdatedAt: number;
}

interface RawBookPayload {
  asks?: BookLevel[];
  bids?: BookLevel[];
  offset?: number;
  last_updated_at?: number;
  /** Last nonce covered by this message. */
  nonce?: number;
  /** Must == the previous message's nonce — otherwise a message was lost. */
  begin_nonce?: number;
}

/** Mutable Map-based book state — pure and unit-testable without a WebSocket. */
export class BookState {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  offset = -1;
  lastUpdatedAt = 0;
  private lastNonce: number | undefined;

  applySnapshot(raw: RawBookPayload): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of raw.bids ?? []) this.bids.set(l.price, l.size);
    for (const l of raw.asks ?? []) this.asks.set(l.price, l.size);
    this.offset = raw.offset ?? -1;
    this.lastUpdatedAt = raw.last_updated_at ?? 0;
    this.lastNonce = raw.nonce;
  }

  /**
   * Apply a delta. `false` means the book can no longer be trusted and the caller
   * must fetch a fresh snapshot.
   *
   * The primary gate = the NONCE CHAIN: this message's begin_nonce must == the
   * previous message's nonce. Verified live on both instances. Offset must NOT be
   * used as a gap gate: on mainnet offset counts internal events and jumps
   * +2..+21 between messages on a busy book (on RH it happens to always be +1) —
   * the strict offset heuristic is only a fallback when the nonce fields are absent.
   */
  applyUpdate(raw: RawBookPayload): boolean {
    const offset = raw.offset ?? -1;
    if (offset <= this.offset) return true; // stale — safe to ignore
    const nonceChainAvailable = this.lastNonce !== undefined && raw.begin_nonce !== undefined;
    if (nonceChainAvailable) {
      if (raw.begin_nonce !== this.lastNonce) return false; // chain broken — message lost
    } else if (this.offset >= 0 && offset > this.offset + 1) {
      return false; // no-nonce fallback: conservative
    }
    for (const l of raw.bids ?? []) {
      if (Number(l.size) === 0) this.bids.delete(l.price);
      else this.bids.set(l.price, l.size);
    }
    for (const l of raw.asks ?? []) {
      if (Number(l.size) === 0) this.asks.delete(l.price);
      else this.asks.set(l.price, l.size);
    }
    this.offset = offset;
    this.lastUpdatedAt = raw.last_updated_at ?? this.lastUpdatedAt;
    if (raw.nonce !== undefined) this.lastNonce = raw.nonce;
    return true;
  }

  toSorted(): OrderBookState {
    const toLevels = (m: Map<string, string>): BookLevel[] =>
      [...m.entries()].map(([price, size]) => ({ price, size }));
    return {
      bids: toLevels(this.bids).sort((a, b) => Number(b.price) - Number(a.price)),
      asks: toLevels(this.asks).sort((a, b) => Number(a.price) - Number(b.price)),
      offset: this.offset,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }
}

export type OrderBookStatus = "connecting" | "live" | "reconnecting";

export interface ConnectOrderBookOptions {
  url?: string;
  onStatus?: (status: OrderBookStatus) => void;
}

interface StreamMessage {
  type?: string;
  channel?: string;
  order_book?: RawBookPayload;
  trades?: TapeTrade[];
  liquidation_trades?: TapeTrade[];
  market_stats?: MarketStats;
}

// market_stats:{id} payload — the only place the funding rate appears in the public API.
export interface MarketStats {
  market_id: number;
  symbol: string;
  mark_price: string;
  index_price: string;
  mid_price: string;
  best_ask_price: string;
  best_bid_price: string;
  open_interest: string;
  last_trade_price: string;
  current_funding_rate: string;
  funding_rate: string;
  [k: string]: unknown;
}

/**
 * Open the order book stream for one market. Returns a disconnect function.
 * Auto-reconnects with backoff; an offset gap triggers a fresh snapshot.
 */
export function connectOrderBook(
  marketId: number,
  onBook: (book: OrderBookState) => void,
  opts: ConnectOrderBookOptions = {},
): () => void {
  const url = opts.url ?? DEFAULT_STREAM_URL;
  const book = new BookState();
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "subscribe", channel: `order_book/${marketId}` }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return;
      }
      if (!msg.order_book) return;
      if (msg.type === "subscribed/order_book") {
        attempt = 0;
        book.applySnapshot(msg.order_book);
        opts.onStatus?.("live");
        onBook(book.toSorted());
      } else if (msg.type === "update/order_book") {
        if (!book.applyUpdate(msg.order_book)) {
          // Gap — safest path: reconnect for a fresh snapshot.
          ws?.close();
          return;
        }
        onBook(book.toSorted());
      }
    };

    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      attempt += 1;
      setTimeout(open, delay);
    };

    ws.onerror = () => {
      ws?.close();
    };
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

/**
 * Trade tape stream for one market. The "subscribed/trade" snapshot carries the
 * last ~50 prints + liquidations; updates follow per print. Dedupe is the caller's
 * job (use TradeTape). Returns a disconnect function.
 */
export function connectTrades(
  marketId: number,
  onTrades: (trades: TapeTrade[]) => void,
  opts: ConnectOrderBookOptions = {},
): () => void {
  const url = opts.url ?? DEFAULT_STREAM_URL;
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "subscribe", channel: `trade/${marketId}` }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return;
      }
      if (msg.type !== "subscribed/trade" && msg.type !== "update/trade") return;
      if (msg.type === "subscribed/trade") {
        attempt = 0;
        opts.onStatus?.("live");
      }
      const prints = [...(msg.trades ?? []), ...(msg.liquidation_trades ?? [])];
      if (prints.length > 0) onTrades(prints);
    };

    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      attempt += 1;
      setTimeout(open, delay);
    };

    ws.onerror = () => {
      ws?.close();
    };
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

/** market_stats stream for one market (mark/index/mid, funding). Returns disconnect. */
export function connectMarketStats(
  marketId: number,
  onStats: (stats: MarketStats) => void,
  opts: ConnectOrderBookOptions = {},
): () => void {
  const url = opts.url ?? DEFAULT_STREAM_URL;
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "subscribe", channel: `market_stats/${marketId}` }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return;
      }
      if (msg.type !== "subscribed/market_stats" && msg.type !== "update/market_stats") return;
      if (msg.type === "subscribed/market_stats") {
        attempt = 0;
        opts.onStatus?.("live");
      }
      if (msg.market_stats) onStats(msg.market_stats);
    };

    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      attempt += 1;
      setTimeout(open, delay);
    };

    ws.onerror = () => {
      ws?.close();
    };
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

/**
 * Every market's stats on one subscription. The venue answers `market_stats/all`
 * with a full snapshot — 235 markets in a single message — then sends partial
 * updates carrying only what moved, so entries are merged rather than replaced.
 *
 * One socket for the whole list beats one per market: a rail showing 200 rows
 * would otherwise open 200 connections to show the same numbers.
 */
export function connectAllMarketStats(
  onStats: (byMarketId: Map<number, MarketStats>) => void,
  opts: ConnectOrderBookOptions = {},
): () => void {
  const url = opts.url ?? DEFAULT_STREAM_URL;
  const byMarketId = new Map<number, MarketStats>();
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "subscribe", channel: "market_stats/all" }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: { type?: string; market_stats?: Record<string, MarketStats> };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== "subscribed/market_stats" && msg.type !== "update/market_stats") return;
      if (!msg.market_stats) return;
      if (msg.type === "subscribed/market_stats") attempt = 0;
      for (const stats of Object.values(msg.market_stats)) {
        if (typeof stats?.market_id === "number") byMarketId.set(stats.market_id, stats);
      }
      opts.onStatus?.("live");
      onStats(byMarketId);
    };

    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      attempt += 1;
      setTimeout(open, delay);
    };

    ws.onerror = () => {
      ws?.close();
    };
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
