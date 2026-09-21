import Link from "next/link";
import { headers } from "next/headers";
import { Attest } from "@/components/Attest";
import { Onboarding } from "@/components/Onboarding";
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
      <Onboarding />

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
        Linking, registering a signing key and depositing all work. The order ticket does not
        exist yet, so nothing here can place a trade — use the venue directly for that until it
        does. The market pages are live and read-only either way.
      </p>
    </>
  );
}
