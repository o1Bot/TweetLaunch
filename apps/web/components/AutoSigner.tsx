"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useRef } from "react";
import { LINKED_EVENT, useGrantSigner } from "@/lib/use-grant-signer";

/**
 * Right after sign-in, ask once for the signer grant so a new user finishes
 * the whole setup from the Connect button: sign in with X, approve the
 * Privy dialog, done. Asked at most once per wallet per browser session;
 * the launch page, the profile and the onboarding page keep a manual
 * button for anyone who closed the dialog.
 */
export function AutoSigner() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { grant, embedded, configured } = useGrantSigner();
  const running = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || !embedded || !configured || running.current) return;
    const key = `o1bot:signer-asked:${embedded.address.toLowerCase()}`;
    let asked = false;
    try {
      asked = sessionStorage.getItem(key) === "1";
    } catch {
      asked = false;
    }
    if (asked) return;
    running.current = true;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/me", { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const me = (await res.json()) as { linked: boolean; wallet: { signerStale?: boolean } | null };
        if (me.linked) return;
        try {
          sessionStorage.setItem(key, "1");
        } catch {
          // Storage can be unavailable; asking again later is harmless.
        }
        // A signer granted before the policy existed is replaced, not added to.
        if (await grant({ replace: Boolean(me.wallet?.signerStale) })) window.dispatchEvent(new Event(LINKED_EVENT));
      } finally {
        running.current = false;
      }
    })();
  }, [ready, authenticated, embedded, configured, getAccessToken, grant]);

  return null;
}
