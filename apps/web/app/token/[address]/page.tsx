import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPrice, formatUsd } from "@o1bot/market";
import { Chart } from "@/components/Chart";
import { SwapPanel } from "@/components/SwapPanel";
import { EXT_ICON, PAIR_CLASS, STOCK_ICON, TokenLogo, X_ICON } from "@/components/TokenLogo";
import { TokenTabs } from "@/components/TokenTabs";
import { shortAddress, timeAgo } from "@/lib/ipfs";
import { getTokenDetail } from "@/lib/market";
import { fetchTokenMetadata } from "@/lib/metadata";

export const dynamic = "force-dynamic";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const O1_TOKEN_URL = (token: string) => `https://launch.o1.exchange/token/4663/${token}`;

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const t = await getTokenDetail(address).catch(() => null);
  if (!t) return { title: "Token not found — o1bot.exchange" };
  return {
    title: `${t.name} (${t.symbol}) — o1bot.exchange`,
    description: `${t.symbol} paired with ${t.quoteSymbol} on Robinhood Chain, launched from a post${t.creator.xHandle ? ` by @${t.creator.xHandle}` : ""}.`,
    openGraph: { title: `${t.name} (${t.symbol})`, images: [t.imageUrl ?? "/logo.png"] },
  };
}

export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const t = await getTokenDetail(address).catch(() => null);
  if (!t) notFound();
  const meta = await fetchTokenMetadata(t.metadataUri);
  const links = [
    meta?.website ? { label: "Website", href: meta.website } : null,
    meta?.x ? { label: "X", href: meta.x } : null,
    meta?.telegram ? { label: "Telegram", href: meta.telegram } : null,
  ].filter((l): l is { label: string; href: string } => l !== null);

  const usd = t.stats.priceUsd;
  const mcap = t.stats.mcapUsd !== null ? formatUsd(t.stats.mcapUsd) : formatPrice(t.stats.mcapQuote, t.quoteSymbol);
  const vol = t.stats.volume24hUsd !== null ? formatUsd(t.stats.volume24hUsd) : formatPrice(t.stats.volume24hQuote, t.quoteSymbol);
  const creatorFees = t.feesQuoteTotal / 2;
  const postText = t.post?.text.replace(/(\$[A-Za-z0-9]+)/g, "<em>$1</em>").replace(/@o1bot_exchange/gi, "<em>@o1bot_exchange</em>");

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
            <TokenLogo symbol={t.symbol} imageUrl={t.imageUrl} />
            <div className="t">
              <div className="l1">
                <h1 className="grad">{t.name}</h1>
                <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>{t.symbol}</span>
                <span className="chain">
                  <i />
                  Robinhood
                </span>
                <span className={PAIR_CLASS[t.quoteKind]}>
                  {t.quoteKind === "stk" && STOCK_ICON}
                  {t.quoteSymbol} pool
                </span>
                {t.source === "DEV" && <span className="tag dev">dev</span>}
              </div>
              <div className="l2">
                <a className="addr" href={`${EXPLORER}/token/${t.token}`} target="_blank" rel="noreferrer">
                  Token <b>{shortAddress(t.token)}</b> {EXT_ICON}
                </a>
                <span className="addr">
                  Creator{" "}
                  {t.creator.xHandle ? (
                    <a href={`https://x.com/${t.creator.xHandle}`} target="_blank" rel="noreferrer">
                      <b>@{t.creator.xHandle}</b>
                    </a>
                  ) : (
                    <b>{shortAddress(t.creator.wallet)}</b>
                  )}
                </span>
                <a className="addr" href={O1_TOKEN_URL(t.token)} target="_blank" rel="noreferrer">
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
            </div>
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
                <div className="k">Trades</div>
                <div className="v">{t.tradeCount.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <div className="genesis">
            <div className="av">{t.creator.xAvatarUrl ? <img src={t.creator.xAvatarUrl} alt="" /> : (t.creator.xHandle ?? t.creator.wallet.slice(2, 3)).slice(0, 1).toUpperCase()}</div>
            <div>
              <div className="who">
                <b>{t.creator.xName ?? (t.creator.xHandle ? `@${t.creator.xHandle}` : shortAddress(t.creator.wallet))}</b>
                {t.creator.xHandle && <span>@{t.creator.xHandle}</span>}
                <span>· {timeAgo(t.post?.postedAt ?? t.launchedAt)}</span>
                {X_ICON}
              </div>
              {t.post ? (
                <div className="body" dangerouslySetInnerHTML={{ __html: postText ?? "" }} />
              ) : (
                <div className="body">Launched on o1bot.exchange from this wallet, without a post.</div>
              )}
              <div className="meta">
                {t.post && t.creator.xHandle && (
                  <a href={`https://x.com/${t.creator.xHandle}/status/${t.post.tweetId}`} target="_blank" rel="noreferrer">
                    Open post {EXT_ICON}
                  </a>
                )}
                <a href={`${EXPLORER}/tx/${t.launchTxHash}`} target="_blank" rel="noreferrer">
                  Launch transaction {EXT_ICON}
                </a>
              </div>
            </div>
            <div className="side">
              Launched
              <b>{new Date(t.launchedAt).toUTCString().replace(" GMT", " UTC")}</b>
              <span className="ok">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 5 5 9-10" />
                </svg>
                Block {t.launchBlock}
              </span>
            </div>
          </div>

          <Chart token={t.token} quoteSymbol={t.quoteSymbol} priceUsd={usd} change24hPct={t.stats.change24hPct} />

          <TokenTabs token={t.token} symbol={t.symbol} quoteSymbol={t.quoteSymbol} initialTrades={t.trades} tradeCount={t.tradeCount} creatorWallet={t.creator.wallet} explorer={EXPLORER} />
        </div>

        <aside>
          <SwapPanel symbol={t.symbol} quoteSymbol={t.quoteSymbol} quoteKind={t.quoteKind} priceQuote={t.stats.priceQuote} launchedAt={t.launchedAt} />
          <div className="card2">
            <h3>Pool</h3>
            <div className="kv">
              <span>Liquidity</span>
              <b>Single-sided, permanent</b>
            </div>
            <div className="kv">
              <span>Supply in pool</span>
              <b>{t.supplyTokens.toLocaleString()} {t.symbol}</b>
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
              <b>o1 · Robinhood Chain</b>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
