import Link from "next/link";
import { headers } from "next/headers";
import { Attest } from "@/components/Attest";
import {
  RESTRICTED_COUNTRIES,
  TERMS_FETCHED_AT,
  TERMS_URL,
  countryFromHeaders,
  countryName,
  eligibility,
} from "@/lib/jurisdiction";

// The gate reads a per-request header, so this page can never be static.
export const dynamic = "force-dynamic";

export const metadata = { title: "Start trading — o1bot perps" };

/**
 * Two ways in, and they are not equivalent. A Lighter account belongs to one L1
 * address, and its L2 API key is registered by a ChangePubKey that address
 * signs. That single fact decides everything below:
 *
 *   - Sign in with X → a Privy embedded wallet o1bot can sign for → the server
 *     can register and hold the L2 key → orders can come from the terminal AND
 *     from a post.
 *   - Connect your own wallet → you sign ChangePubKey in the browser and the
 *     key stays in the local vault → the terminal works and from-a-post cannot,
 *     because no server ever holds a key to sign with.
 *
 * The second is not a reduced version of the first, it is the choice to keep
 * custody, so the page states the trade instead of burying it.
 *
 * Using both means two L1 addresses, therefore two Lighter accounts and two
 * separate pools of collateral. Never render them as one balance.
 */
const PATHS = [
  {
    key: "x",
    title: "Sign in with X",
    body: "o1bot creates a wallet for your X account and can sign for it, so orders work from the terminal and from a post.",
    trades: "Terminal + from a post",
  },
  {
    key: "wallet",
    title: "Connect a wallet",
    body: "You sign in the browser and your Lighter key never leaves it. o1bot cannot trade for you, which also means a post cannot.",
    trades: "Terminal only",
  },
] as const;

const STEPS = [
  {
    n: 3,
    title: "Fund it",
    // Deposit stays on the venue for now. Moving a user's money is the highest
    // risk surface in the app, and Lighter's own flow already does it: the
    // cross-chain route needs an intent-address endpoint that is not public and
    // has to be traced from their frontend first, and the direct route is
    // Ethereum mainnet gas. We are the screen, not the exchange.
    body: "Deposit USDC through Lighter's own flow. Your collateral sits with the venue — o1bot never holds it and cannot withdraw it.",
  },
  {
    n: 4,
    title: "Set a cap, then trade",
    body: "Choose the most a single order may risk. The cap is enforced here, not only by the venue.",
  },
] as const;

export default async function StartPage() {
  const country = countryFromHeaders(await headers());
  const check = eligibility(country);

  return (
    <main className="wrap narrow">
      <nav className="crumb">
        <Link href="/">← All markets</Link>
      </nav>

      <header className="head">
        <h1 className="grad">Start trading.</h1>
        <p>
          Four steps, once. How you link decides what you get afterwards: the terminal either way,
          and orders from a post only where o1bot can sign for the wallet.
        </p>
      </header>

      <section className="panel gate">
        <div className="gateh">
          <h2>1. Eligibility</h2>
          <span className={`status ${check.status === "restricted" ? "reconnecting" : check.status === "allowed" ? "live" : ""}`}>
            {check.status === "allowed"
              ? `${countryName(check.country)} — ok`
              : check.status === "restricted"
                ? `${countryName(check.country)} — not available`
                : "location unknown"}
          </span>
        </div>

        <p>
          Lighter states that its services are not available to people who reside in, are located
          in, or are incorporated in:{" "}
          <strong>{RESTRICTED_COUNTRIES.map(countryName).join(", ")}</strong>. Its terms separately
          exclude any jurisdiction under comprehensive sanctions.
        </p>
        <p className="fine">
          From <a href={TERMS_URL}>{TERMS_URL}</a>, read {TERMS_FETCHED_AT}. Lighter enforces its own
          terms whatever this page says.
        </p>
      </section>

      {check.status === "restricted" ? (
        <div className="err gate">
          <h2>Not available where you are</h2>
          <p>
            This request looks like it comes from {countryName(check.country)}, which Lighter's terms
            exclude. There is no way around this and we are not going to suggest one. You can still
            read every market — prices, charts and order books stay open.
          </p>
          <p>
            <Link href="/">← Back to the markets</Link>
          </p>
        </div>
      ) : check.status === "unknown" ? (
        <Attest>
          <Steps />
        </Attest>
      ) : (
        <Steps />
      )}
    </main>
  );
}

function Steps() {
  return (
    <>
      <section className="panel gate pending">
        <div className="gateh">
          <h2>2. Link a Lighter account</h2>
          <span className="soon">not open yet</span>
        </div>
        <p>Two ways in. They give you different things, so pick on that basis.</p>
        <div className="paths">
          {PATHS.map((p) => (
            <div key={p.key} className="path">
              <h3>{p.title}</h3>
              <p>{p.body}</p>
              <span className="tag">{p.trades}</span>
            </div>
          ))}
        </div>
        <p className="fine">
          Each wallet is its own Lighter account with its own collateral. Using both does not pool
          them.
        </p>
      </section>

      {STEPS.map((s) => (
        <section key={s.n} className="panel gate pending">
          <div className="gateh">
            <h2>
              {s.n}. {s.title}
            </h2>
            <span className="soon">not open yet</span>
          </div>
          <p>{s.body}</p>
        </section>
      ))}
      <p className="note">
        Steps 2 to 4 are not built yet — nothing here places an order or moves money. The market
        pages are live and read-only in the meantime.
      </p>
    </>
  );
}
