import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPrice, formatUsd } from "@o1bot/market";
import { ChainIcon } from "@/components/ChainIcons";
import { Chart } from "@/components/Chart";
import { SwapPanel } from "@/components/SwapPanel";
import { EXT_ICON, PairMark, TokenLogo, X_ICON } from "@/components/TokenLogo";
import { TokenTabs } from "@/components/TokenTabs";
import { CHAIN_LABEL, CHAIN_SHORT, EXPLORER, o1TokenUrl, type ChainKey } from "@/lib/chains-web";
import type { Account } from "@/lib/fee-recipient";
import { shortAddress, timeAgo } from "@/lib/ipfs";
import { getTokenDetail, swapsAvailable } from "@/lib/market";
import { fetchTokenMetadata } from "@/lib/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const t = await getTokenDetail(address).catch(() => null);
  if (!t) return { title: "Token not found — o1bot.exchange" };
  return {
    title: `${t.name} (${t.symbol}) — o1bot.exchange`,
    description: `${t.symbol} paired with ${t.quoteSymbol} on ${CHAIN_LABEL[t.chain]}, launched from a post${t.creator.xHandle ? ` by @${t.creator.xHandle}` : ""}.`,
    // The image is app/token/[address]/opengraph-image.tsx: logo, chain and live figures.
    openGraph: { title: `${t.name} (${t.symbol})`, type: "website" },
    twitter: { card: "summary_large_image", site: "@o1bot_exchange" },
  };
}

/** A small round avatar: the X picture when we have one, else the first letter. */
function Avatar({ account }: { account: Account }) {
  const initial = (account.xHandle ?? (account.wallet.slice(2, 3) || "?")).slice(0, 1).toUpperCase();
  return <span className="av">{account.xAvatarUrl ? <img src={account.xAvatarUrl} alt="" referrerPolicy="no-referrer" /> : initial}</span>;
}

const accountName = (a: Account) => (a.xHandle ? `@${a.xHandle}` : shortAddress(a.wallet));
const accountHref = (a: Account, chain: ChainKey) => (a.xHandle ? `https://x.com/${a.xHandle}` : `${EXPLORER[chain]}/address/${a.wallet}`);

/**
 * The launch post as HTML: entities X already escaped are decoded, everything
 * is escaped again, then tickers and the bot's handle are highlighted. The
 * post is someone else's text, so nothing in it may reach the page as markup.
 */
function postHtml(text: string): string {
  const decoded = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const escaped = decoded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.replace(/(\$[A-Za-z0-9]+)/g, "<em>$1</em>").replace(/@o1bot_exchange/gi, "<em>$&</em>");
}

export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const t = await getTokenDetail(address).catch(() => null);
  if (!t) notFound();
  const meta = await fetchTokenMetadata(t.metadataUri);
  // The token's own site comes first; a metadata website that is the same address is not listed twice.
  const ownSite = t.siteUrl?.replace(/\/$/, "") ?? null;
  const metaWebsite = meta?.website && meta.website.replace(/\/$/, "") !== ownSite ? meta.website : null;
  const links = [
    ownSite ? { label: "Website", href: ownSite } : null,
    metaWebsite ? { label: ownSite ? "Other website" : "Website", href: metaWebsite } : null,
    meta?.x ? { label: "X", href: meta.x } : null,
    meta?.telegram ? { label: "Telegram", href: meta.telegram } : null,
  ].filter((l): l is { label: string; href: string } => l !== null);

  const { creator, feeTo } = t;
  const usd = t.stats.priceUsd;
  const mcap = t.stats.mcapUsd !== null ? formatUsd(t.stats.mcapUsd) : formatPrice(t.stats.mcapQuote, t.quoteSymbol);
  const vol = t.stats.volume24hUsd !== null ? formatUsd(t.stats.volume24hUsd) : formatPrice(t.stats.volume24hQuote, t.quoteSymbol);
  const volAll = t.stats.volumeAllUsd !== null ? formatUsd(t.stats.volumeAllUsd) : formatPrice(t.stats.volumeAllQuote, t.quoteSymbol);
  const creatorFees = t.feesQuoteTotal / 2;
  const launchedAt = new Date(t.launchedAt).toUTCString().replace(/:\d\d GMT$/, " UTC");
  const feeTitle =
    feeTo.sharePct !== null
      ? `${feeTo.sharePct}% of the creator fees on every trade go to this account; the rest goes to the o1bot treasury.`
      : "The creator fees on every trade go to this account.";

  return (
    <main className="wrap">
      <Link className="back" href="/">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back to board
      </Link>
      <div className="tp">
        <div>
          <div className="thead">
            <div className="th-top">
              <TokenLogo symbol={t.symbol} imageUrl={t.imageUrl} />
              <div className="th-id">
                <div className="th-name">
                  <h1 className="grad">{t.name}</h1>
                  <span className="th-sym">${t.symbol}</span>
                </div>
                <div className="th-chips">
                  <span className="chip-s">
                    <ChainIcon chain={t.chain} size={14} />
                    {CHAIN_SHORT[t.chain]}
                  </span>
                  <span className={`pair ${t.quoteKind}`}>
                    <PairMark symbol={t.quoteSymbol} kind={t.quoteKind} />
                    {t.quoteSymbol} pool
                  </span>
                  {t.source === "DEV" && <span className="tag dev">dev</span>}
                </div>
              </div>
            </div>

            <div className="th-meta">
              <a className="feeto" href={accountHref(feeTo, t.chain)} target="_blank" rel="noreferrer" title={feeTitle}>
                <Avatar account={feeTo} />
                <span className="k">{feeTo.isOther ? "Fees go to" : "Creator fees to"}</span>
                <b>{accountName(feeTo)}</b>
                {feeTo.sharePct !== null && <span className="pct">{feeTo.sharePct}%</span>}
              </a>
              {feeTo.isOther && (
                <span className="addr">
                  Launched by{" "}
                  <a href={accountHref(creator, t.chain)} target="_blank" rel="noreferrer">
                    <b>{accountName(creator)}</b>
                  </a>
                </span>
              )}
              <a className="addr" href={`${EXPLORER[t.chain]}/token/${t.token}`} target="_blank" rel="noreferrer">
                Token <b>{shortAddress(t.token)}</b> {EXT_ICON}
              </a>
              <a className="addr" href={o1TokenUrl(t.token, t.chain)} target="_blank" rel="noreferrer">
                View on o1 {EXT_ICON}
              </a>
            </div>

            {(meta?.description || links.length > 0) && (
              <div className="about">
                {meta?.description && <p>{meta.description}</p>}
                {links.length > 0 && (
                  <div className="links">
                    {links.map((l) => (
                      <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
                        {l.label} {EXT_ICON}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="stats">
              <div>
                <div className="k">Market cap</div>
                <div className="v">{mcap}</div>
              </div>
              <div>
                <div className="k">24h volume</div>
                <div className="v">{vol}</div>
              </div>
              <div>
                <div className="k">All-time volume</div>
                <div className="v">{volAll}</div>
              </div>
              <div>
                <div className="k">Trades</div>
                <div className="v">{t.tradeCount.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <Chart token={t.token} quoteSymbol={t.quoteSymbol} priceUsd={usd} change24hPct={t.stats.change24hPct} />

          <TokenTabs token={t.token} symbol={t.symbol} quoteSymbol={t.quoteSymbol} initialTrades={t.trades} tradeCount={t.tradeCount} creatorWallet={t.creator.wallet} explorer={EXPLORER[t.chain]} />
        </div>

        <aside>
          {swapsAvailable(t.chain) ? (
            <SwapPanel token={t.token} chainId={t.chainId} symbol={t.symbol} quoteSymbol={t.quoteSymbol} quoteKind={t.quoteKind} launchedAt={t.launchedAt} />
          ) : (
            <div className="card2">
              <h3>Trade</h3>
              <p style={{ color: "var(--ink-2)", lineHeight: 1.5, margin: "8px 0 14px" }}>
                Trading {t.symbol} from this site is not open on {CHAIN_LABEL[t.chain]} yet: the chain has no Universal Router. Trade it on o1 for now; the chart and trades here stay live.
              </p>
              <a className="btn-p" href={o1TokenUrl(t.token, t.chain)} target="_blank" rel="noreferrer">
                Trade on o1 {EXT_ICON}
              </a>
            </div>
          )}
          <div className="card2">
            <h3>Pool</h3>
            <div className="kv">
              <span>Liquidity</span>
              <b>Single-sided, permanent</b>
            </div>
            <div className="kv">
              <span>Total supply</span>
              <b>
                {t.supplyTokens.toLocaleString()} {t.symbol}
              </b>
            </div>
            <div className="kv">
              <span>Burned</span>
              <b>{t.burnedTokens > 0 ? `${t.burnedTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${t.symbol} (${((t.burnedTokens / t.supplyTokens) * 100).toFixed(2)}%)` : "0"}</b>
            </div>
            <div className="kv">
              <span>Circulating</span>
              <b>
                {t.circulatingTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} {t.symbol}
              </b>
            </div>
            <div className="kv">
              <span>Fees paid in</span>
              <b>{t.quoteSymbol}</b>
            </div>
            <div className="kv">
              <span>Creator fees earned</span>
              <b>{formatPrice(creatorFees, t.quoteSymbol)}</b>
            </div>
            <div className="kv">
              <span>Price</span>
              <b>{formatPrice(t.stats.priceQuote, t.quoteSymbol)}</b>
            </div>
            <div className="kv">
              <span>Factory</span>
              <b>o1 · {CHAIN_LABEL[t.chain]}</b>
            </div>
          </div>

          <div className="card2 launch">
            <h3>Launch</h3>
            <a className="who" href={accountHref(creator, t.chain)} target="_blank" rel="noreferrer">
              <Avatar account={creator} />
              <span className="n">
                <b>{creator.xName ?? accountName(creator)}</b>
                <span>
                  {creator.xHandle ? `@${creator.xHandle} · ` : ""}
                  {timeAgo(t.post?.postedAt ?? t.launchedAt)}
                </span>
              </span>
              {X_ICON}
            </a>
            {t.post ? <p className="body" dangerouslySetInnerHTML={{ __html: postHtml(t.post.text) }} /> : <p className="body muted">Launched on o1bot.exchange from this wallet, without a post.</p>}
            <div className="kv">
              <span>Launched</span>
              <b>{launchedAt}</b>
            </div>
            <div className="kv">
              <span>Block</span>
              <b>{Number(t.launchBlock).toLocaleString("en-US")}</b>
            </div>
            <div className="links">
              {t.post && creator.xHandle && (
                <a href={`https://x.com/${creator.xHandle}/status/${t.post.tweetId}`} target="_blank" rel="noreferrer">
                  Open post {EXT_ICON}
                </a>
              )}
              <a href={`${EXPLORER[t.chain]}/tx/${t.launchTxHash}`} target="_blank" rel="noreferrer">
                Launch transaction {EXT_ICON}
              </a>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
