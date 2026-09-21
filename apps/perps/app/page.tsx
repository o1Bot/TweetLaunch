import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { changePct, price, usd } from "@/lib/format";
import { loadPerps } from "@/lib/markets";

export const revalidate = 60;

export default async function HomePage() {
  const { rows, error } = await loadPerps();
  const best = rows.reduce((m, r) => Math.max(m, r.maxLeverage), 0);

  return (
    <>
      <TopBar />
      <main className="page">
        <section className="hero">
          <span className="eyebrow">
            <i />
            In development on perps.o1bot.exchange
          </span>
          <h1>Perps you can open from a post.</h1>
          <p>
            Long or short crypto and tokenised stocks with USDC margin. Trade in the terminal, or —
            once it ships — mention the bot on X and it signs from a wallet you authorised, inside
            caps you set. Lighter matches and settles every order and holds the collateral.
          </p>
          <div className="cmd">
            <b>@o1bot_exchange</b> long <em>$NVDA</em> 5x with 500 usdc
          </div>
          <div className="cta2">
            <Link className="btn p" href={rows[0] ? `/perps/${rows[0].symbol}` : "/start"}>
              Open the terminal
            </Link>
            <Link className="btn" href="/start">
              Set up an account
            </Link>
          </div>
        </section>

        {/* Four numbers, each one true. The fee cards the design calls for would
            say what o1bot charges; it has no integrator account on the venue
            yet, so it charges nothing, and that is what these say. */}
        <section className="hstats">
          <div>
            <b>{error ? "—" : rows.length}</b>
            <span>Perp markets, crypto and RWA</span>
          </div>
          <div>
            <b>{error ? "—" : `${best}x`}</b>
            <span>Highest leverage on the venue</span>
          </div>
          <div>
            <b>0%</b>
            <span>o1bot fee — no integrator account yet</span>
          </div>
          <div>
            <b>USDC</b>
            <span>Margin and settlement</span>
          </div>
        </section>

        <section>
          <div className="sech">
            <h2>Markets</h2>
            <span>{error ? "Venue unreachable" : "Pick one to open the terminal"}</span>
          </div>

          {error ? (
            <div className="err gate">
              Could not reach Lighter: {error}. Nothing is cached yet, so there are no prices to
              show. It recovers on its own once the venue answers.
            </div>
          ) : (
            <div className="mgrid">
              {rows.map((m) => {
                const c = changePct(m.changePct);
                return (
                  <Link key={m.symbol} className="mcard" href={`/perps/${m.symbol}`}>
                    <div className="t">
                      <i className={m.category === "crypto" ? "c" : "k"} />
                      <b>{m.symbol}</b>
                      <em>{m.maxLeverage}x</em>
                    </div>
                    <div className="p">{price(m.lastPrice)}</div>
                    <div className="r">
                      <b className={c.cls}>{c.text}</b>
                      <span>24h</span>
                    </div>
                    <div className="k">
                      <span>
                        Vol <b>{usd(m.volumeUsd)}</b>
                      </span>
                      <span>
                        OI <b>{usd(m.openInterestUsd)}</b>
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
