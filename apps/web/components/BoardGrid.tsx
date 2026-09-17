import Link from "next/link";
import { formatPct, formatPrice, formatUsd } from "@o1bot/market";
import { CHAIN_SHORT } from "@/lib/chains-web";
import { timeAgo } from "@/lib/ipfs";
import type { TokenRow } from "@/lib/types";
import { ChainIcon } from "./ChainIcons";
import { PAIR_CLASS, PairMark, TokenLogo, X_ICON } from "./TokenLogo";

/**
 * The board as a grid of cards: the logo large, then ticker, pair and chain,
 * market cap with the day's change, and who launched it. Same rows, same
 * order as the table; the toolbar switches between the two.
 */
export function BoardGrid({ rows, emptyText }: { rows: TokenRow[]; emptyText?: string }) {
  if (rows.length === 0) {
    return (
      <div className="board">
        <div className="empty">{emptyText ?? "No launches yet. The first token launched through @o1bot_exchange will show up here."}</div>
      </div>
    );
  }
  return (
    <div className="cards">
      {rows.map((t) => {
        const change = t.stats.change24hPct;
        const mcap = t.stats.mcapUsd !== null ? formatUsd(t.stats.mcapUsd) : formatPrice(t.stats.mcapQuote, t.quoteSymbol);
        const vol = t.stats.volume24hUsd !== null ? formatUsd(t.stats.volume24hUsd) : formatPrice(t.stats.volume24hQuote, t.quoteSymbol);
        // The account the fees go to leads when it is not the one that launched the token.
        const who = t.feeTo.isOther ? t.feeTo : t.creator;
        return (
          <Link className="card" href={`/token/${t.token}`} key={t.token}>
            <TokenLogo symbol={t.symbol} imageUrl={t.imageUrl} className="card-logo" />
            <div className="card-head">
              <b className="card-sym">{t.symbol}</b>
              <span className={PAIR_CLASS[t.quoteKind]}>
                <PairMark symbol={t.quoteSymbol} kind={t.quoteKind} />
                {t.quoteSymbol}
              </span>
              <span className="card-chain" title={CHAIN_SHORT[t.chain]}>
                <ChainIcon chain={t.chain} size={16} />
              </span>
              {t.siteUrl && <span className="tag site">site</span>}
              {t.source === "DEV" && <span className="tag dev">dev</span>}
            </div>
            <div className="card-name" title={t.name}>
              {t.name}
            </div>
            <div className="card-num">
              <b>{mcap}</b>
              <span className={change !== null && change < 0 ? "down" : "up"}>{formatPct(change)}</span>
              <small>{vol} 24h</small>
            </div>
            <div className="card-foot" title={t.feeTo.isOther ? `Creator fees go to this account; launched by ${t.creator.xHandle ? `@${t.creator.xHandle}` : t.creator.wallet}` : undefined}>
              {who.xAvatarUrl ? <img src={who.xAvatarUrl} alt="" referrerPolicy="no-referrer" /> : X_ICON}
              <span>
                {t.feeTo.isOther ? "fees to " : ""}
                {who.xHandle ? `@${who.xHandle}` : `${who.wallet.slice(0, 6)}…${who.wallet.slice(-4)}`}
              </span>
              <em>{timeAgo(t.launchedAt)}</em>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
