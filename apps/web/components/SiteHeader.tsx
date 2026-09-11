import { cookies } from "next/headers";
import Link from "next/link";
import { CHAIN_COOKIE, DEFAULT_CHAIN, isChainKey } from "@/lib/chains-web";
import { ChainSwitch } from "./ChainSwitch";
import { HeaderAccount } from "./HeaderAccount";
import { DOCS_URL, SITE_NAME } from "./links";
import { MobileMenu } from "./MobileMenu";
import { SearchBox } from "./SearchBox";

export async function SiteHeader() {
  const saved = (await cookies()).get(CHAIN_COOKIE)?.value;
  const chain = isChainKey(saved) ? saved : DEFAULT_CHAIN;
  return (
    <header className="top">
      <Link className="brand" href="/">
        <img className="mark" src="/mark.png" alt="" width={26} height={26} />
        {SITE_NAME}
      </Link>
      <ChainSwitch current={chain} />
      <nav className="nav" aria-label="Main">
        <Link href="/">Board</Link>
        <Link href="/launch">Launch</Link>
        <Link href="/sites">Sites</Link>
        <Link href="/how-it-works">How it works</Link>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          Docs
        </a>
      </nav>
      <div className="grow" />
      <SearchBox />
      <HeaderAccount />
      <MobileMenu />
    </header>
  );
}
