import type { Metadata } from "next";
import { SwapAny } from "@/components/SwapAny";

export const metadata: Metadata = {
  title: "Swap — o1bot.exchange",
  description: "Swap any token on Robinhood Chain, Base or Arc: ETH, stablecoins, every stock, every token launched through o1bot, or an address you paste, from your own o1bot wallet.",
};

export default function SwapPage() {
  return (
    <main className="wrap swap-page">
      <SwapAny />
    </main>
  );
}
