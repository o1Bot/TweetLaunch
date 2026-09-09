"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useRef, useState } from "react";
import { DOCS_URL } from "./links";
import { SearchBox } from "./SearchBox";

/**
 * Navigation for narrow screens, where the inline nav is hidden: one button
 * that opens a dropdown with every page plus sign-in / sign-out.
 */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const wrap = useRef<HTMLDivElement>(null);
  const { ready, authenticated, user, login, logout } = usePrivy();

  // Close on navigation, outside click and Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handle = user?.twitter?.username ?? null;

  return (
    <div className="mmenu-wrap" ref={wrap}>
      <button className="mmenu-btn" type="button" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          {open ? (
            <>
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </>
          ) : (
            <>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </>
          )}
        </svg>
      </button>
      {open && (
        <nav className="mmenu" aria-label="Menu">
          <SearchBox compact />
          <Link href="/">Board</Link>
          <Link href="/launch">Launch a token</Link>
          <Link href="/how-it-works">How it works</Link>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            Docs
          </a>
          <Link href="/me">Profile{handle ? ` · @${handle}` : ""}</Link>
          <div className="sep" />
          {!ready ? null : authenticated ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void logout();
              }}
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                login();
              }}
            >
              Connect with X
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
