import type { Metadata } from "next";
import { Onboarding } from "@/components/Onboarding";

export const metadata: Metadata = {
  title: "Launch a token — o1bot.exchange",
  description: "Link your X account, top up the launch fee once, and post the command.",
};

export default function StartPage() {
  return (
    <main className="wrap">
      <section className="hero">
        <h1>
          <span className="grad">Three things, once.</span>
        </h1>
        <p>Link the X account you will post from, keep a little ETH in the wallet o1bot creates for it, and post the command. After that every launch is one post.</p>
      </section>
      <Onboarding />
    </main>
  );
}
