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

const STEPS = [
  {
    n: 2,
    title: "Link a Lighter account",
    body: "Sign once with your wallet to register an API key in o1bot's own slot. The key stays encrypted in your browser and is never sent to a server.",
  },
  {
    n: 3,
    title: "Fund it",
    body: "Move USDC onto Lighter. Your collateral sits with the venue — o1bot never holds it and cannot withdraw it.",
  },
  {
    n: 4,
    title: "Set a cap, then trade",
    body: "Choose the most a single order may risk. Trade from the terminal here, or later from a post on X.",
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
          Four steps, once. After that the terminal and the bot both work from the same account.
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
