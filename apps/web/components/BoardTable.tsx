import Link from "next/link";
import { formatPct, formatPrice, formatUsd } from "@o1bot/market";
import { timeAgo } from "@/lib/ipfs";
import type { TokenRow } from "@/lib/types";
import { PAIR_CLASS, STOCK_ICON, TokenLogo, X_ICON } from "./TokenLogo";

export function BoardTable({ rows }: { rows: TokenRow[] }) {
  return (
    <div className="board">
      <div className="row head">
        <span />
        <span>Token · origin post</span>
        <span className="num">Price</span>
        <span className="num">24h</span>
        <span className="num hide">Volume 24h</span>
        <span className="hide">Pair</span>
        <span />
      </div>
      {rows.length === 0 && <div className="empty">No launches yet. The first token launched through @o1bot_exchange will show up here.</div>}
      {rows.map((t) => (
        <Link className="row" href={`/token/${t.token}`} key={t.token}>
          <TokenLogo symbol={t.symbol} imageUrl={t.imageUrl} />
          <div className="tok">
            <div className="nm">
              {t.name}
              <span className="sym">{t.symbol}</span>
              <span className="chain">
                <i />
                Robinhood
              </span>
              {t.source === "DEV" && <span className="tag dev">dev</span>}
            </div>
            <div className="post">
              {X_ICON}
              {t.post && t.creator.xHandle ? (
                <>
                  <b>@{t.creator.xHandle}</b>
                  <span>{t.post.text.replace(/^@o1bot_exchange\s*/i, "")}</span>
                </>
              ) : (
                <span>
                  {t.creator.wallet.slice(0, 6)}…{t.creator.wallet.slice(-4)} · launched {timeAgo(t.launchedAt)}
                </span>
              )}
            </div>
          </div>
          <div className="num">
            {t.stats.priceUsd !== null ? formatUsd(t.stats.priceUsd) : formatPrice(t.stats.priceQuote, t.quoteSymbol)}
            <small>mcap {t.stats.mcapUsd !== null ? formatUsd(t.stats.mcapUsd) : formatPrice(t.stats.mcapQuote, t.quoteSymbol)}</small>
          </div>
          <div className={`num pct ${t.stats.change24hPct !== null && t.stats.change24hPct < 0 ? "down" : "up"}`}>{formatPct(t.stats.change24hPct)}</div>
          <div className="num hide">
            {t.stats.volume24hUsd !== null ? formatUsd(t.stats.volume24hUsd) : formatPrice(t.stats.volume24hQuote, t.quoteSymbol)}
            <small>{t.tradeCount.toLocaleString()} trades</small>
          </div>
          <div className="hide">
            <span className={PAIR_CLASS[t.quoteKind]}>
              {t.quoteKind === "stk" && STOCK_ICON}
              {t.quoteSymbol}
            </span>
          </div>
          <div className="arrow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 5 7 7-7 7" />
            </svg>
          </div>
        </Link>
      ))}
    </div>
  );
}
