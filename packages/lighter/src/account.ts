// Account stream — the account_all/{index} channel is PUBLIC (Lighter is a
// transparent exchange; anyone can watch any account's positions). Full snapshot
// on subscribe, then incremental updates: a null slice means unchanged.
// The account_all_orders channel REQUIRES an auth token — open orders come with
// that tier. Shapes verified live against an active mainnet MM account, 2026-07-29.

import { DEFAULT_STREAM_URL, type ConnectOrderBookOptions } from "./ws";

export interface AccountPosition {
  market_id: number;
  symbol: string;
  /** 1 = long, -1 = short. */
  sign: 1 | -1;
  position: string;
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  realized_pnl: string;
  liquidation_price: string;
  open_order_count?: number;
  [k: string]: unknown;
}

export interface AccountAsset {
  asset_id: number;
  symbol: string;
  balance: string;
  locked_balance: string;
  margin_balance?: string;
  [k: string]: unknown;
}

export interface AccountFill {
  trade_id?: number;
  market_id?: number;
  price?: string;
  size?: string;
  usd_amount?: string;
  timestamp?: number;
  [k: string]: unknown;
}

interface AccountAllMessage {
  type?: string;
  account?: number;
  assets?: Record<string, AccountAsset> | null;
  positions?: Record<string, AccountPosition> | null;
  trades?: Record<string, AccountFill[]> | null;
}

/** Merged account state — pure, testable without a WebSocket. */
export class AccountState {
  private assetsById = new Map<string, AccountAsset>();
  private positionsByMarket = new Map<string, AccountPosition>();
  private fillsByMarket = new Map<string, AccountFill[]>();
  version = 0;

  apply(msg: AccountAllMessage): void {
    if (msg.assets) {
      for (const [k, v] of Object.entries(msg.assets)) this.assetsById.set(k, v);
    }
    if (msg.positions) {
      for (const [k, v] of Object.entries(msg.positions)) this.positionsByMarket.set(k, v);
    }
    if (msg.trades) {
      for (const [k, v] of Object.entries(msg.trades)) {
        if (Array.isArray(v) && v.length > 0) {
          const existing = this.fillsByMarket.get(k) ?? [];
          const seen = new Set(existing.map((f) => f.trade_id));
          this.fillsByMarket.set(k, [...existing, ...v.filter((f) => !seen.has(f.trade_id))]);
        }
      }
    }
    this.version += 1;
  }

  /** Non-zero positions, largest first by value. */
  positions(): AccountPosition[] {
    return [...this.positionsByMarket.values()]
      .filter((p) => Number(p.position) !== 0)
      .sort((a, b) => Number(b.position_value) - Number(a.position_value));
  }

  assets(): AccountAsset[] {
    return [...this.assetsById.values()].sort((a, b) => a.asset_id - b.asset_id);
  }

  /** Newest fills first, at most `limit`. */
  fills(limit = 50): AccountFill[] {
    const all: AccountFill[] = [];
    for (const arr of this.fillsByMarket.values()) all.push(...arr);
    return all.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit);
  }
}

/** Account stream. Returns a disconnect function. State is merged internally. */
export function connectAccount(
  accountIndex: number,
  onState: (state: AccountState) => void,
  opts: ConnectOrderBookOptions = {},
): () => void {
  const url = opts.url ?? DEFAULT_STREAM_URL;
  const state = new AccountState();
  let ws: WebSocket | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "subscribe", channel: `account_all/${accountIndex}` }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: AccountAllMessage;
      try {
        msg = JSON.parse(ev.data) as AccountAllMessage;
      } catch {
        return;
      }
      if (msg.type !== "subscribed/account_all" && msg.type !== "update/account_all") return;
      if (msg.type === "subscribed/account_all") {
        attempt = 0;
        opts.onStatus?.("live");
      }
      state.apply(msg);
      onState(state);
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
