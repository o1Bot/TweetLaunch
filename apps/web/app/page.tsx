import { Onboarding } from "@/components/Onboarding";

export default function Home() {
  return (
    <main className="wrap">
      <section className="hero">
        <h1>
          <span className="grad">
            Launch on o1.
            <br />
            From a post.
          </span>
        </h1>
        <p>
          o1bot.exchange turns a mention on X into a real launch on o1 Launchpad. Link your account, top up your
          wallet once, then post the command. The bot signs with your wallet, so the creator address and the trading
          fees are yours.
        </p>
      </section>
      <Onboarding />
    </main>
  );
}
