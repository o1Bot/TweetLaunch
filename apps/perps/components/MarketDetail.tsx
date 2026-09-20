import { displaySymbol, maxLeverage, type MarketType } from "@o1bot/lighter";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Chart } from "@/components/Chart";
import { Trades } from "@/components/Trades";
import { MAX_BARS, toBars, windowFor } from "@/lib/candles";
import { changePct, leverage, price, usd } from "@/lib/format";
import { MARKETS_REVALIDATE_SECONDS, lighter, revalidating } from "@/lib/lighter";

const DEFAULT_RESOLUTION = "1h" as const;

export async function MarketDetail({ symbol, type }: { symbol: string; type: MarketType }) {
  const details = await lighter.orderBookDetails(revalidating(MARKETS_REVALIDATE_SECONDS));
  const list = type === "perp" ? details.order_book_details : details.spot_order_book_details;

  // Symbols come from a URL, so compare case-insensitively; spot symbols carry a
  // quote suffix ("LIT/USDC") that a link should not have to repeat.
  const wanted = decodeURIComponent(symbol).toUpperCase();
  const market = list.find((m) => m.symbol.toUpperCase() === wanted || m.symbol.split("/")[0]?.toUpperCase() === wanted);
  if (!market) notFound();

  const perp = type === "perp" ? (market as (typeof details.order_book_details)[number]) : null;

  const { startMs, endMs } = windowFor(DEFAULT_RESOLUTION, MAX_BARS);
  const [candles, trades] = await Promise.all([
    lighter
      .candles(market.market_id, DEFAULT_RESOLUTION, startMs, endMs, MAX_BARS, revalidating(60))
      .then((r) => toBars(r.c))
      .catch(() => []),
    lighter
      .recentTrades(market.market_id, 50, revalidating(15))
      .then((r) => r.trades)
      .catch(() => []),
  ]);

  const change = changePct(market.daily_price_change);

  return (
    <main className="wrap">
      <nav className="crumb">
        <Link href="/">← All markets</Link>
      </nav>

      <header className="mhead">
        <div className="mtitle">
          <h1>{displaySymbol(market)}</h1>
          <span className={`tag ${type}`}>{type === "perp" ? "PERP" : "SPOT"}</span>
        </div>
        <dl className="stats">
          <div>
            <dt>Last</dt>
            <dd>{price(market.last_trade_price)}</dd>
          </div>
          <div>
            <dt>24h</dt>
            <dd className={change.cls}>{change.text}</dd>
          </div>
          <div>
            <dt>24h volume</dt>
            <dd>{usd(market.daily_quote_token_volume)}</dd>
          </div>
          <div>
            <dt>24h range</dt>
            <dd>
              {price(market.daily_price_low)} – {price(market.daily_price_high)}
            </dd>
          </div>
          {perp && (
            <>
              <div>
                <dt>Mark</dt>
                <dd>{price(perp.mark_price)}</dd>
              </div>
              <div>
                <dt>Max leverage</dt>
                <dd>{leverage(maxLeverage(perp))}</dd>
              </div>
              <div>
                <dt>Open interest</dt>
                <dd>{usd(perp.open_interest * market.last_trade_price)}</dd>
              </div>
            </>
          )}
        </dl>
      </header>

      <div className="mgrid">
        <Chart marketId={market.market_id} initialBars={candles} initialResolution={DEFAULT_RESOLUTION} />
        <Trades trades={trades} />
      </div>

      <p className="note">
        Read-only for now: this page shows the venue, it does not place orders. Lighter matches and
        settles every trade and holds the collateral; o1bot never does.
      </p>
    </main>
  );
}
