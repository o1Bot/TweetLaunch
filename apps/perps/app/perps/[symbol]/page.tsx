import { notFound } from "next/navigation";
import Link from "next/link";
import { Blotter } from "@/components/Blotter";
import { Chart } from "@/components/Chart";
import { MarketLogo } from "@/components/MarketLogo";
import { MarketsRail } from "@/components/MarketsRail";
import { OrderBook } from "@/components/OrderBook";
import { Ticket } from "@/components/Ticket";
import { TopBar } from "@/components/TopBar";
import { MAX_BARS, toBars, windowFor } from "@/lib/candles";
import { changePct, price, usd } from "@/lib/format";
import { lighter, revalidating } from "@/lib/lighter";
import { findPerp, loadPerps } from "@/lib/markets";
import "../../terminal.css";

export const revalidate = 60;

const DEFAULT_RESOLUTION = "1h" as const;

export default async function TerminalPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const { rows } = await loadPerps();
  const m = findPerp(rows, symbol);
  if (!m) notFound();

  const { startMs, endMs } = windowFor(DEFAULT_RESOLUTION, MAX_BARS);
  const bars = await lighter
    .candles(m.marketId, DEFAULT_RESOLUTION, startMs, endMs, MAX_BARS, revalidating(60))
    .then((r) => toBars(r.c))
    .catch(() => []);

  const c = changePct(m.changePct);

  return (
    <>
      <TopBar />

      <div className="tbar">
        <Link className="back" href="/">
          ← Markets
        </Link>
        <b>Terminal</b>
        <span>USDC margin · funding paid hourly by the venue</span>
        <div className="grow" />
        <span>Trade from a post is not live yet</span>
      </div>

      <div className="tapp">
        <MarketsRail
          current={m.symbol}
          markets={rows.map((r) => ({
            symbol: r.symbol,
            href: `/perps/${r.symbol}`,
            lastPrice: r.lastPrice,
            changePct: r.changePct,
            volumeUsd: r.volumeUsd,
            kind: r.category === "crypto" ? "crypto" : "rwa",
          }))}
        />

        <section className="tcol">
          <div className="mhead">
            <div className="name">
              <MarketLogo symbol={m.symbol} size={26} />
              <h1>{m.symbol}-PERP</h1>
              <span className={`tagp${m.category === "rwa" ? " k" : ""}`}>
                {m.category === "crypto" ? "Crypto" : "RWA"}
              </span>
            </div>
            <div className="px">
              <b>{price(m.lastPrice)}</b>
              <span className={c.cls}>{c.text}</span>
            </div>
            <div className="mstats">
              <div>
                <span>Mark</span>
                <b>{price(m.markPrice)}</b>
              </div>
              <div>
                <span>Open interest</span>
                <b>{usd(m.openInterestUsd)}</b>
              </div>
              <div>
                <span>24h volume</span>
                <b>{usd(m.volumeUsd)}</b>
              </div>
              <div>
                <span>Max leverage</span>
                <b>{m.maxLeverage}x</b>
              </div>
            </div>
          </div>

          <div className="chartwrap">
            <Chart marketId={m.marketId} initialBars={bars} initialResolution={DEFAULT_RESOLUTION} />
          </div>

          <Blotter markets={rows} />
        </section>

        <OrderBook marketId={m.marketId} />

        <Ticket
          symbol={m.symbol}
          mark={m.markPrice}
          maxLeverage={m.maxLeverage}
          market={{
            market_id: m.marketId,
            supported_price_decimals: m.priceDecimals,
            supported_size_decimals: m.sizeDecimals,
            maintenance_margin_fraction: m.maintenanceMarginBps,
          }}
        />
      </div>
    </>
  );
}
