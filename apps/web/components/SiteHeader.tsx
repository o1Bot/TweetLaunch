import Link from "next/link";
import { DOCS_URL, SITE_NAME } from "./links";

export function SiteHeader() {
  return (
    <header className="top">
      <Link className="brand" href="/">
        <img className="mark" src="/mark.png" alt="" width={26} height={26} />
        {SITE_NAME}
      </Link>
      <nav className="nav" aria-label="Main">
        <Link href="/how-it-works">How it works</Link>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          Docs
        </a>
      </nav>
      <div className="grow" />
    </header>
  );
}
