"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { base, robinhood } from "viem/chains";
import type { ReactNode } from "react";
import { AutoSigner } from "@/components/AutoSigner";

/**
 * Privy: X login only, one embedded Ethereum wallet per user, created on
 * first login. The bot signs launches with this wallet after the user grants
 * delegated signing (see Onboarding step 2).
 */
export function Providers({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    return (
      <div className="wrap">
        <div className="alert">NEXT_PUBLIC_PRIVY_APP_ID is not set. Copy .env.example to .env and fill it in.</div>
      </div>
    );
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["twitter"],
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: true },
        defaultChain: robinhood,
        supportedChains: [robinhood, base],
        appearance: {
          theme: "#151D29",
          accentColor: "#2F7BFF",
          walletChainType: "ethereum-only",
        },
      }}
    >
      <AutoSigner />
      {children}
    </PrivyProvider>
  );
}
