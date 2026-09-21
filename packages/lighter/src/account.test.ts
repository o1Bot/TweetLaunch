import { describe, expect, it } from "vitest";
import { AccountState, type AccountPosition } from "./account";

const pos = (market_id: number, position: string, extra: Partial<AccountPosition> = {}) =>
  ({
    market_id,
    symbol: `M${market_id}`,
    sign: 1,
    position,
    avg_entry_price: "100",
    position_value: String(Number(position) * 100),
    unrealized_pnl: "0",
    realized_pnl: "0",
    liquidation_price: "50",
    ...extra,
  }) as AccountPosition;

describe("AccountState", () => {
  it("snapshot then update: a null slice does not erase old data", () => {
    const s = new AccountState();
    s.apply({
      assets: { "3": { asset_id: 3, symbol: "USDC", balance: "10", locked_balance: "0" } },
      positions: { "1": pos(1, "2.5") },
    });
    // update without assets (null) — positions change, assets stay
    s.apply({ assets: null, positions: { "1": pos(1, "3.0") } });
    expect(s.assets()).toHaveLength(1);
    expect(s.positions()[0]!.position).toBe("3.0");
  });

  it("posisi nol disaring, urut nilai terbesar", () => {
    const s = new AccountState();
    s.apply({
      positions: {
        "1": pos(1, "1.0"),
        "2": pos(2, "0.00000"),
        "3": pos(3, "5.0"),
      },
    });
    expect(s.positions().map((p) => p.market_id)).toEqual([3, 1]);
  });

  it("fills: deduped by trade_id, newest first", () => {
    const s = new AccountState();
    s.apply({ trades: { "1": [{ trade_id: 1, timestamp: 100 }, { trade_id: 2, timestamp: 200 }] } });
    s.apply({ trades: { "1": [{ trade_id: 2, timestamp: 200 }, { trade_id: 3, timestamp: 300 }] } });
    expect(s.fills().map((f) => f.trade_id)).toEqual([3, 2, 1]);
  });

  it("version increments per message — used as the render dirty check", () => {
    const s = new AccountState();
    expect(s.version).toBe(0);
    s.apply({ positions: null });
    s.apply({ positions: { "1": pos(1, "1") } });
    expect(s.version).toBe(2);
  });
});
