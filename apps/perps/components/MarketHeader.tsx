"use client";

import { MarketLogo } from "@/components/MarketLogo";
import { useMarketStats } from "@/components/StatsContext";
import { changePct, price, usd } from "@/lib/format";
import type { PerpRow } from "@/lib/markets";

/**
 * The server's render is the starting point, not the answer: it is replaced by
 * the stream as soon as the venue answers. Rendering the server value first
 * means the page is never blank, and rendering only that meant a price that
 * never moved until someone reloaded.
 */
export function MarketHeader({ market }: { market: PerpRow }) {
  const live = useMarketStats(market.marketId);

  const last = live ? Number(live.last_trade_price) || market.lastPrice : market.lastPrice;
  const mark = live ? Number(live.mark_price) || market.markPrice : market.markPrice;
  const change = live ? Number(live.daily_price_change) : market.changePct;
  const volume = live ? Number(live.daily_quote_token_volume) : market.volumeUsd;
  /**
   * The two endpoints report open interest in different units, verified on
   * 2026-09-25 for BTC: orderBookDetails gives 2058.68844 — base units, which
   * lib/markets.ts already multiplies into USD — while market_stats gives
   * 173,339,720, which is USD already. Multiplying the live one as well
   * rendered $14,593.54B of open interest on Bitcoin.
   */
  const oiUsd = live ? Number(live.open_interest) : market.openInterestUsd;
  const funding = live ? Number(live.current_funding_rate) : null;

  const c = changePct(change);

  return (
    <div className="mhead">
      <div className="name">
        <MarketLogo symbol={market.symbol} size={26} />
        <h1>{market.symbol}-PERP</h1>
        <span className={`tagp${market.category === "rwa" ? " k" : ""}`}>
          {market.category === "crypto" ? "Crypto" : "RWA"}
        </span>
      </div>
      <div className="px">
        <b>{price(last)}</b>
        <span className={c.cls}>{c.text}</span>
      </div>
      <div className="mstats">
        <div>
          <span>Mark</span>
          <b>{price(mark)}</b>
        </div>
        {funding !== null && Number.isFinite(funding) && (
          <div>
            <span>Funding</span>
            <b className={funding > 0 ? "up" : funding < 0 ? "down" : ""}>
              {funding > 0 ? "+" : ""}
              {funding.toFixed(4)}%
            </b>
          </div>
        )}
        <div>
          <span>Open interest</span>
          <b>{usd(oiUsd)}</b>
        </div>
        <div>
          <span>24h volume</span>
          <b>{usd(volume)}</b>
        </div>
        <div>
          <span>Max leverage</span>
          <b>{market.maxLeverage}x</b>
        </div>
      </div>
    </div>
  );
}
