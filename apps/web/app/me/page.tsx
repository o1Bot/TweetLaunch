import type { Metadata } from "next";
import { Profile } from "@/components/Profile";

export const metadata: Metadata = {
  title: "Profile — o1bot.exchange",
  description: "Your wallet, your holdings, your launches and the creator fees waiting for you.",
};

export default function MePage() {
  return (
    <main className="wrap me">
      <Profile />
    </main>
  );
}
