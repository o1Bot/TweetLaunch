"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { mainnet } from "viem/chains";
import type { ReactNode } from "react";
import { AccountProvider, NoAccountProvider } from "@/components/AccountContext";

/**
 * Two ways in, on purpose (see app/start/page.tsx for why they differ):
 *
 *   twitter — an embedded wallet o1bot can sign for, so orders can come from a
 *             post as well as from here
 *   wallet  — the visitor's own wallet; o1bot can never sign for it, so this
 *             path is the terminal only
 *
 * Defaults to the same NEXT_PUBLIC_PRIVY_APP_ID as the main site, so a session
 * started at o1bot.exchange carries over. NEXT_PUBLIC_PRIVY_APP_ID_PERPS
 * overrides it if this domain ever needs its own Privy app — in which case the
 * two sites stop sharing logins, which is the point of keeping it separate.
 *
 * Chain is Ethereum mainnet: that is the L1 a Lighter account belongs to, where
 * deposits and secure withdrawals settle. Registering an API key is a signed
 * message rather than a transaction, so it costs no gas here.
 */
export function Providers({ children }: { children: ReactNode }) {
  const appId =
    process.env.NEXT_PUBLIC_PRIVY_APP_ID_PERPS || process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    // Without this the provider throws and the whole app blanks, including the
    // market pages, which need no wallet at all.
    return <NoAccountProvider>{children}</NoAccountProvider>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["twitter", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: true },
        defaultChain: mainnet,
        supportedChains: [mainnet],
        appearance: {
          theme: "#26272c",
          accentColor: "#2f7bff",
          walletChainType: "ethereum-only",
        },
      }}
    >
      <AccountProvider>{children}</AccountProvider>
    </PrivyProvider>
  );
}
