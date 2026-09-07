import Link from "next/link";
import { formatUsd } from "@o1bot/market";
import { BoardTable } from "@/components/BoardTable";
import { DOCS_URL } from "@/components/links";
import { boardTotals, listBoardTokens } from "@/lib/market";
import type { TokenRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  let rows: TokenRow[] = [];
  let dbError: string | null = null;
  try {
    rows = await listBoardTokens();
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }
  const totals = await boardTotals(rows);

  return (
    <main className="wrap">
      <section className="hero">
        <h1>
          <span className="grad">
            Launch on o1.
            <br />
            From a post.
          </span>
        </h1>
        <p>
          o1bot.exchange turns a mention on X into a real launch on o1 Launchpad. Link your account, top up your wallet once, then post the command. The bot mines an 01 address, signs
          with your wallet, and opens a permanent Uniswap v4 pool on Robinhood Chain. No form, no site to visit.
        </p>
        <div className="hero-cta">
          <Link className="btn-p" href="/start">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Launch a token
          </Link>
          <a className="btn-s" href={DOCS_URL} target="_blank" rel="noreferrer">
            How it works
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
        </div>
        <div className="hero-stats">
          <div>
            <b>{totals.launches.toLocaleString()}</b>
            <span>Tokens launched from posts</span>
          </div>
          <div>
            <b>{totals.volume24hUsd !== null ? formatUsd(totals.volume24hUsd) : "—"}</b>
            <span>Volume through o1bot, 24h</span>
          </div>
          <div>
            <b>196</b>
            <span>Pairs on Robinhood Chain</span>
          </div>
          <div>
            <b>0.5%</b>
            <span>Of every trade to the creator</span>
          </div>
        </div>
      </section>

      <div className="toolbar">
        <span className="chip on">All launches</span>
        <div className="grow" />
        <span className="sort">Sorted by 24h volume</span>
      </div>
      {dbError ? <div className="empty">The board is not connected to a database yet.</div> : <BoardTable rows={rows} />}
    </main>
  );
}
