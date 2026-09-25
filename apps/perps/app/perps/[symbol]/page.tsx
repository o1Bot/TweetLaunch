import { notFound } from "next/navigation";
import Link from "next/link";
import { Blotter } from "@/components/Blotter";
import { Chart } from "@/components/Chart";
import { MarketHeader } from "@/components/MarketHeader";
import { MarketsRail } from "@/components/MarketsRail";
import { StatsProvider } from "@/components/StatsContext";
import { OrderBook } from "@/components/OrderBook";
import { Ticket } from "@/components/Ticket";
import { TopBar } from "@/components/TopBar";
import { MAX_BARS, toBars, windowFor } from "@/lib/candles";
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


  return (
    <StatsProvider>
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
            marketId: r.marketId,
            symbol: r.symbol,
            href: `/perps/${r.symbol}`,
            lastPrice: r.lastPrice,
            changePct: r.changePct,
            volumeUsd: r.volumeUsd,
            kind: r.category === "crypto" ? "crypto" : "rwa",
          }))}
        />

        {/* The blotter is a grid child rather than a child of the chart column:
            on one column the ticket has to follow the chart directly, and a
            blotter nested in the chart column would always come between them. */}
        <section className="tcol chartcol">
          <MarketHeader market={m} />
          <div className="chartwrap">
            <Chart marketId={m.marketId} initialBars={bars} initialResolution={DEFAULT_RESOLUTION} />
          </div>
        </section>

        <section className="tcol blotcol">
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
    </StatsProvider>
  );
}
