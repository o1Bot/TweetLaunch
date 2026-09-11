import type { Metadata } from "next";
import { LaunchForm } from "@/components/LaunchForm";
import { SITES_ROOT_DOMAIN } from "@/lib/site-domain";

export const metadata: Metadata = {
  title: "Launch a token — o1bot.exchange",
  description: "Launch a token on Robinhood Chain through o1 Launchpad from the wallet tied to your X account.",
};

export default function LaunchPage() {
  return (
    <main className="wrap lf">
      <LaunchForm sitesRootDomain={SITES_ROOT_DOMAIN} />
    </main>
  );
}
