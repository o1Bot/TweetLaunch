import { maxLeverage } from "@o1bot/lighter";
import { MarketTable, type MarketRow } from "@/components/MarketTable";
import { MARKETS_REVALIDATE_SECONDS, lighter, revalidating } from "@/lib/lighter";

export const revalidate = 60;

async function loadMarkets(): Promise<{ rows: MarketRow[]; error?: string }> {
  try {
    const res = await lighter.orderBookDetails(revalidating(MARKETS_REVALIDATE_SECONDS));

    const perps: MarketRow[] = res.order_book_details.map((m) => ({
      marketId: m.market_id,
      symbol: m.symbol,
      type: "perp",
      lastPrice: m.last_trade_price,
      changePct: m.daily_price_change,
      volumeUsd: m.daily_quote_token_volume,
      // min_initial_margin_fraction is in basis points; the package turns it into a cap.
      maxLeverage: maxLeverage(m),
    }));

    const spot: MarketRow[] = res.spot_order_book_details.map((m) => ({
      marketId: m.market_id,
      symbol: m.symbol,
      type: "spot",
      lastPrice: m.last_trade_price,
      changePct: m.daily_price_change,
      volumeUsd: m.daily_quote_token_volume,
      maxLeverage: null,
    }));

    // Busiest first: with 240+ markets an alphabetical list buries everything
    // anyone actually trades.
    const rows = [...perps, ...spot].sort((a, b) => b.volumeUsd - a.volumeUsd);
    return { rows };
  } catch (e) {
    // The venue being unreachable is not a crash — say so and keep the page up.
    return { rows: [], error: e instanceof Error ? e.message : "unknown error" };
  }
}

export default async function MarketsPage() {
  const { rows, error } = await loadMarkets();
  const perpCount = rows.filter((r) => r.type === "perp").length;
  const spotCount = rows.length - perpCount;

  return (
    <main className="wrap">
      <header className="head">
        <h1 className="grad">Perps on Lighter.</h1>
        <p>
          Stocks, gold, oil, treasuries, FX and pre-IPO — quoted in USDC. o1bot builds and routes
          the order; Lighter matches and settles, and holds the collateral.
        </p>
        <p className="venue">
          {error ? "Markets unavailable" : `${rows.length} markets live · ${perpCount} perp · ${spotCount} spot`}
        </p>
      </header>

      {error ? (
        <div className="err">
          Could not reach Lighter: {error}. Nothing is cached yet, so this page has no prices to
          show. It will recover on its own once the venue answers.
        </div>
      ) : (
        <MarketTable rows={rows} />
      )}

      <p className="note">
        Trading is not open here yet — this page reads the venue, nothing more. Lighter is
        unavailable in several jurisdictions; eligibility is checked before any account is linked.
      </p>
    </main>
  );
}
