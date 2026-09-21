import type { Trade } from "@o1bot/lighter";

function time(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

function size(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * `is_maker_ask` describes the resting side, so a true value means the taker
 * lifted the ask and therefore bought. The venue does not document this, so it
 * was measured: over 100 consecutive BTC trades on 2026-09-20, the `true` group
 * printed a mean $3.00 above the `false` group (n = 48 vs 52) — about one
 * spread, on the ask side. Good evidence, not proof; recheck against a known
 * own-order fill before anything depends on it beyond tape colour.
 */
function takerSide(t: Trade): "buy" | "sell" {
  return t.is_maker_ask ? "buy" : "sell";
}

export function Trades({ trades }: { trades: Trade[] }) {
  return (
    <div className="panel tradesbox">
      <div className="boxh">
        <h2>Recent trades</h2>
      </div>
      {trades.length === 0 ? (
        <p className="muted empty">No trades in the window.</p>
      ) : (
        <div className="scroll tradescroll">
          <table className="trades">
            <thead>
              <tr>
                <th>Price</th>
                <th>Size</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.trade_id}>
                  <td className={takerSide(t) === "buy" ? "up" : "down"}>{t.price}</td>
                  <td>{size(t.size)}</td>
                  <td className="muted">{time(t.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
