"use client";

import { useSigners, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Key quorum id of o1bot's authorization key; users add it as a signer on their wallet. */
export const SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID ?? "";

/** Fired on `window` when the signer was granted somewhere on the page, so open views refresh. */
export const LINKED_EVENT = "o1bot:linked";

/** Re-run `refresh` whenever the signer gets granted elsewhere (for example by the automatic prompt after sign-in). */
export function useLinkedRefresh(refresh: () => void | Promise<void>) {
  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener(LINKED_EVENT, handler);
    return () => window.removeEventListener(LINKED_EVENT, handler);
  }, [refresh]);
}

/**
 * One place for "allow o1bot to sign launches from this wallet": finds the
 * embedded wallet and adds o1bot's key quorum as a signer. The bot's own
 * allow-list still decides which transactions it will ever sign.
 */
export function useGrantSigner() {
  const { wallets } = useWallets();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const embedded = useMemo(() => wallets.find((w) => w.walletClientType === "privy") ?? null, [wallets]);

  const grant = useCallback(async (): Promise<boolean> => {
    if (!embedded) {
      setError("Your wallet is still being created. Try again in a moment.");
      return false;
    }
    if (!SIGNER_ID) {
      setError("This deployment has no signer configured (NEXT_PUBLIC_PRIVY_SIGNER_ID).");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await addSigners({ address: embedded.address, signers: [{ signerId: SIGNER_ID, policyIds: [] }] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Granting access was cancelled.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [embedded, addSigners]);

  return { grant, busy, error, embedded, configured: Boolean(SIGNER_ID) };
}
