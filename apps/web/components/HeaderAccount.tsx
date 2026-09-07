"use client";

import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";

const X_MARK = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.9 2H22l-7.2 8.3L23 22h-6.6l-5.2-6.8L5.3 22H2.1l7.7-8.8L1.6 2h6.8l4.7 6.2L18.9 2zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20z" />
  </svg>
);

/**
 * Top-right account control: "Connect" until the user signs in with X,
 * then their X avatar and handle, which open the profile page.
 */
export function HeaderAccount() {
  const { ready, authenticated, user, login } = usePrivy();

  if (!ready) return <span className="acct-slot" aria-hidden="true" />;

  if (!authenticated) {
    return (
      <button className="btn-p acct-connect" onClick={() => login()} type="button">
        {X_MARK}
        Connect
      </button>
    );
  }

  const handle = user?.twitter?.username ?? null;
  const avatar = user?.twitter?.profilePictureUrl ?? null;
  const initial = (handle ?? "?").slice(0, 1).toUpperCase();
  return (
    <Link className="acct" href="/me" title="Your profile">
      <span className="acct-av">{avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : initial}</span>
      <span className="acct-name">{handle ? `@${handle}` : "Profile"}</span>
      <span className="acct-x">{X_MARK}</span>
    </Link>
  );
}
