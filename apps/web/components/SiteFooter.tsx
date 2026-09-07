import Link from "next/link";
import { BOT_HANDLE, CONTACT_EMAIL, DOCS_URL, GITHUB_URL, SITE_NAME, X_URL } from "./links";

const X_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.9 2H22l-7.2 8.3L23 22h-6.6l-5.2-6.8L5.3 22H2.1l7.7-8.8L1.6 2h6.8l4.7 6.2L18.9 2zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20z" />
  </svg>
);

const GITHUB_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.2.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
  </svg>
);

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <div className="footer-brand">
          <div className="brand">
            <img className="mark" src="/mark.png" alt="" width={26} height={26} />
            {SITE_NAME}
          </div>
          <p>Launch on o1 Launchpad from a post on X. Your wallet, your creator fees.</p>
          <div className="social">
            <a href={X_URL} target="_blank" rel="noreferrer" aria-label={`@${BOT_HANDLE} on X`}>
              {X_ICON}
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub">
              {GITHUB_ICON}
            </a>
          </div>
        </div>
        <div className="footer-col">
          <b>Product</b>
          <Link href="/how-it-works">How it works</Link>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            Docs
          </a>
          <a href={`${DOCS_URL}#/command`} target="_blank" rel="noreferrer">
            The launch command
          </a>
          <a href={`${DOCS_URL}#/pairs`} target="_blank" rel="noreferrer">
            Pairs
          </a>
          <a href={`${DOCS_URL}#/fees`} target="_blank" rel="noreferrer">
            Fees
          </a>
        </div>
        <div className="footer-col">
          <b>Legal</b>
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/terms">Terms of use</Link>
        </div>
        <div className="footer-col">
          <b>Contact</b>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          <a href={X_URL} target="_blank" rel="noreferrer">
            @{BOT_HANDLE}
          </a>
        </div>
      </div>
      <div className="wrap footer-bottom">
        <span>© 2026 {SITE_NAME}</span>
        <span>Built on o1 Launchpad, Robinhood Chain.</span>
      </div>
    </footer>
  );
}
