"use client";

import { connectAccount, type AccountState, type OrderBookStatus } from "@o1bot/lighter";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LinkStatus } from "@/lib/account";
import { vaultKey } from "@/lib/register";

export interface AccountView {
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  address: string | null;
  /** True when o1bot can sign for this wallet, so a post could drive it too. */
  embedded: boolean;
  accountIndex: number | null;
  /** A signing key for this account exists in this browser. */
  hasKey: boolean;
  state: AccountState | null;
  stream: OrderBookStatus | "idle";
  /** Collateral the venue reports for the account, or null before it answers. */
  collateral: number | null;
  availableBalance: number | null;
  refresh: () => void;
}

const Ctx = createContext<AccountView | null>(null);

export function useAccount(): AccountView {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount outside AccountProvider");
  return v;
}

/**
 * One account, one stream. The top bar, the blotter and the ticket all need the
 * same positions and balances; giving each its own subscription would mean
 * three sockets showing three slightly different moments of the same account.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const address = wallet?.address ?? null;

  const [link, setLink] = useState<LinkStatus | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [stream, setStream] = useState<OrderBookStatus | "idle">("idle");
  const [, bump] = useState(0);
  const stateRef = useRef<AccountState | null>(null);

  const refresh = useCallback(() => {
    if (!address) {
      setLink(null);
      return;
    }
    fetch(`/api/account?address=${address}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((s: LinkStatus) => setLink(s))
      .catch(() => setLink({ state: "error", message: "could not reach the venue" }));
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const accountIndex = link?.state === "linked" ? link.account.index : null;

  useEffect(() => {
    if (accountIndex === null) {
      setHasKey(false);
      return;
    }
    try {
      setHasKey(localStorage.getItem(vaultKey(accountIndex)) !== null);
    } catch {
      setHasKey(false);
    }
  }, [accountIndex]);

  useEffect(() => {
    stateRef.current = null;
    if (accountIndex === null) {
      setStream("idle");
      bump((n) => n + 1);
      return;
    }
    // Positions move on every tick of every market the account is in, so the
    // state lands in a ref and the tree repaints on a timer, the same way the
    // order book does.
    const disconnect = connectAccount(
      accountIndex,
      (s) => {
        stateRef.current = s;
      },
      { onStatus: setStream },
    );
    const timer = setInterval(() => bump((n) => n + 1), 500);
    return () => {
      disconnect();
      clearInterval(timer);
    };
  }, [accountIndex]);

  const value: AccountView = {
    ready,
    authenticated,
    login,
    address,
    embedded: wallet?.walletClientType === "privy",
    accountIndex,
    hasKey,
    state: stateRef.current,
    stream,
    collateral: link?.state === "linked" ? link.account.collateral : null,
    availableBalance: link?.state === "linked" ? link.account.availableBalance : null,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Used when no Privy app id is configured. The market pages need no wallet, so
 * they render with an account that is plainly absent rather than with hooks
 * that cannot run — and useAccount stays strict, so a genuinely missing
 * provider still throws instead of quietly showing an empty account.
 */
export function NoAccountProvider({ children }: { children: ReactNode }) {
  const value: AccountView = {
    ready: true,
    authenticated: false,
    login: () => {},
    address: null,
    embedded: false,
    accountIndex: null,
    hasKey: false,
    state: null,
    stream: "idle",
    collateral: null,
    availableBalance: null,
    refresh: () => {},
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
