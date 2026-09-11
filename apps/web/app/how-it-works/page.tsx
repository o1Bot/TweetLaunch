import type { Metadata } from "next";
import Link from "next/link";
import { BOT_HANDLE, DOCS_URL, SITE_NAME } from "@/components/links";

export const metadata: Metadata = {
  title: `How it works — ${SITE_NAME}`,
  description: "Link X, top up once, post the command. The bot launches on o1 Launchpad from your own wallet and replies with the token.",
};

export default function HowItWorksPage() {
  return (
    <main className="wrap">
      <article className="legal how">
        <p className="eyebrow">How it works</p>
        <h1>
          <span className="grad">Three things, once. Then every launch is one post.</span>
        </h1>
        <p className="meta">
          {SITE_NAME} turns a mention of @{BOT_HANDLE} into a real launch on o1 Launchpad, signed by a wallet that is yours.
        </p>

        <ol className="howsteps">
          <li>
            <span className="n">1</span>
            <div>
              <b>Link your X account</b>
              <p>Sign in with X on the home page. That creates your wallet, secured by Privy. Then allow the bot to sign launches from it. You can export the key or revoke the permission whenever you like.</p>
            </div>
          </li>
          <li>
            <span className="n">2</span>
            <div>
              <b>Top up the launch fee</b>
              <p>Send ETH on Robinhood Chain to your wallet. A plain launch needs o1's 0.001 ETH creation fee plus gas, about 0.002 ETH in total. Add more if you want a dev buy.</p>
            </div>
          </li>
          <li>
            <span className="n">3</span>
            <div>
              <b>Post the command</b>
              <p>Mention the bot with the ticker, name, and pair. Attach an image and it becomes the logo. Within about a minute the bot replies with the token address and links.</p>
            </div>
          </li>
        </ol>

        <div className="cmdbox">
          <div className="cmd-l">The command</div>
          <div className="cmd">
            <b>@{BOT_HANDLE}</b> launch <em>$TICKER</em> &quot;Token name&quot; pair <em>ETH</em> on <em>robinhood</em>
          </div>
          <div className="cmd-opts">
            Optional: <em>devbuy 0.05</em> buys at launch without the anti-snipe fee · <em>fees to @someone</em> sends creator fees to another account · <em>site</em> builds the token a website
          </div>
        </div>

        <h2>Ask it things</h2>
        <p>
          The bot also answers questions from its own data, in any language: how many tokens it has launched and their volume, what is trending, how one token is doing (price, market cap, holders), and for your own account your balances, deposit address, launches, claimable fees and past trades. Mention it and ask in your own words. It only ever shows you your own wallet.
        </p>

        <h2>A website for your token</h2>
        <p>
          End the launch command with <em>site</em> (or <em>site yourname</em>) and the bot also builds a one-page website for the token at <em>yourname.{SITE_NAME}</em>: your story, how to buy, live price, holders and a buy button. It replies with the link when the site is up, usually within two minutes, and you keep editing it at <em>{SITE_NAME}/site/yourname</em>: describe a change in plain words, preview it, publish it. The creator of a token that already exists can ask later with <em>build a site for $TICKER</em>.
        </p>

        <h2>What the bot does behind the scenes</h2>
        <ul>
          <li>Reads the post and asks one question if the ticker, name, or pair is missing. It never guesses.</li>
          <li>Checks that your account is linked, the pair is registered on o1's factory, and your wallet holds enough ETH.</li>
          <li>Pins the image and metadata to IPFS, mines a token address ending in 01 as o1 requires, and simulates the whole launch.</li>
          <li>Signs the launch from your wallet, waits for confirmation, and replies under your post.</li>
        </ul>

        <h2>What you get</h2>
        <ul>
          <li>A normal o1 token: same factory, same pool, same audits as a launch made on o1's own site.</li>
          <li>You are the on-chain creator and earn 0.5% of every trade in the paired asset.</li>
          <li>196 pairs on Robinhood Chain: ETH, USDG, and 194 stock tokens.</li>
        </ul>

        <h2>What it costs</h2>
        <p>
          Nothing from us. Your wallet pays o1's creation fee (0.001 ETH) and gas. Trading pays o1's 1% swap fee, split between the creator, o1, and the app the trade came through.
        </p>

        <div className="two" style={{ marginTop: 22 }}>
          <a className="btn-s" href={DOCS_URL} target="_blank" rel="noreferrer">
            Read the docs
          </a>
          <Link className="btn-p" href="/">
            Link your X account
          </Link>
        </div>
      </article>
    </main>
  );
}
