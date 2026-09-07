import type { Metadata } from "next";
import { BOT_HANDLE, CONTACT_EMAIL, LEGAL_UPDATED, SITE_NAME } from "@/components/links";

export const metadata: Metadata = {
  title: `Terms of use — ${SITE_NAME}`,
  description: `The rules for using the ${SITE_NAME} bot and website to launch tokens on o1 Launchpad from your own wallet.`,
};

export default function TermsPage() {
  return (
    <main className="wrap">
      <article className="legal">
        <p className="eyebrow">Legal</p>
        <h1>
          <span className="grad">Terms of use</span>
        </h1>
        <p className="meta">Last updated {LEGAL_UPDATED}</p>

        <p>
          These terms apply to the X bot @{BOT_HANDLE} and the website at {SITE_NAME} (together, the "service"), operated by {SITE_NAME} ("we", "us"). By linking your X account, funding the wallet the service creates for you, or posting a launch command, you agree to them.
        </p>

        <h2>1. What the service is</h2>
        <p>
          The service turns a post on X into a token launch on o1 Launchpad, a third-party protocol on Robinhood Chain. We operate the bot, the website, and the wallets described below. We do not operate the launch contracts, the liquidity pools, or the fee escrow; those belong to o1 Launchpad. We are not affiliated with o1 Launchpad, Robinhood, X, or Privy.
        </p>

        <h2>2. Eligibility</h2>
        <p>
          You must be at least 18 years old and legally able to use crypto-asset services where you live. You may not use the service if you are subject to sanctions or located in a jurisdiction where it would be unlawful.
        </p>

        <h2>3. Your wallet and the permission you give the bot</h2>
        <ul>
          <li>Signing in with X creates an embedded wallet for you through Privy. You control it: you can view it, fund it, export its private key, and use it elsewhere.</li>
          <li>The bot can only act from your wallet after you grant delegated signing in the website. You can revoke that permission at any time.</li>
          <li>The bot only signs these transactions to o1's contracts: creating a launch (with or without a dev buy), an ERC-20 approval a launch may need, changing the creator fee recipient, and claiming fees. It never sends plain transfers, never signs messages, and never signs to other contracts or chains.</li>
          <li>You fund your wallet. We never front fees or gas, never hold your funds, and never receive your private key.</li>
          <li>Keep only what you intend to spend in this wallet.</li>
        </ul>

        <h2>4. Launches</h2>
        <ul>
          <li>Posting a launch command is an instruction to submit a transaction from your wallet. Once confirmed on chain it cannot be undone. Check the ticker, name, pair, and amounts before posting.</li>
          <li>You are responsible for the token name, ticker, image, and any text you attach. Do not use names, marks, or images you have no right to use, and do not impersonate people, companies, or existing assets.</li>
          <li>We simulate every launch before signing, but a simulation is not a guarantee. A transaction can still fail on chain; gas spent on a failed transaction is not refundable by us.</li>
          <li>A dev buy is executed in the same transaction as the launch. If it cannot complete within the slippage protection, the whole launch reverts and no token is created.</li>
          <li>Using <code>fees to @handle</code> instructs us to point the creator fee stream at that account's wallet. The recipient does not have to accept; you remain responsible for the launch.</li>
        </ul>

        <h2>5. Fees</h2>
        <p>
          We do not charge for launches. Your wallet pays o1's creation fee, network gas, and any dev buy. Trading in the pool pays o1's swap fee, part of which goes to the creator and part to the platform or referrer, as documented by o1. Trades made through this website carry {SITE_NAME} as referrer, for which o1 pays us a share of that fee; traders pay nothing extra.
        </p>

        <h2>6. Acceptable use</h2>
        <ul>
          <li>No spam, harassment, or abuse of the bot or other users.</li>
          <li>No tickers that match a stock token symbol registered on o1's factory, and no attempts to pass a token off as a security, a stock, or an official asset of any company.</li>
          <li>No use of the service to break sanctions, launder money, or commit fraud.</li>
          <li>Rate limits apply per X account. We may refuse a launch, ignore a post, or suspend an account that breaks these rules, without notice.</li>
        </ul>

        <h2>7. No advice, no guarantees</h2>
        <p>
          Nothing the bot or the website says is financial, legal, or tax advice. Tokens launched through the service are speculative and may lose all value. We make no promise about a token's price, liquidity, listing, or the behaviour of o1 Launchpad, Robinhood Chain, or any third party.
        </p>

        <h2>8. Third-party services</h2>
        <p>
          The service depends on o1 Launchpad, Robinhood Chain, X, Privy, Anthropic, and IPFS pinning providers, each under its own terms. If one of them changes, pauses, or fails, the service may stop working, and we are not responsible for their conduct.
        </p>

        <h2>9. Disclaimer of warranties</h2>
        <p>
          The service is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose, non-infringement, and uninterrupted or error-free operation. The service is in beta and may change or stop at any time.
        </p>

        <h2>10. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, we are not liable for any indirect, incidental, consequential, or special damages, or for lost profits, lost tokens, or lost data, arising from the service or from a launch, whether or not we were advised of the possibility. Our total liability for any claim relating to the service is limited to the amount of fees, if any, you paid to us in the twelve months before the claim, which for a free service is zero.
        </p>

        <h2>11. Indemnity</h2>
        <p>
          You will defend and hold us harmless from claims arising out of a token you launched, content you attached, or your breach of these terms.
        </p>

        <h2>12. Changes and termination</h2>
        <p>
          We may change these terms by updating this page and the date at the top; continued use after a change means you accept it. We may suspend or end the service, or your access to it, at any time. Your wallet remains yours regardless.
        </p>

        <h2>13. Governing law</h2>
        <p>
          These terms are governed by the laws of the jurisdiction in which {SITE_NAME} is established, without regard to its conflict-of-law rules. Where the law of your place of residence gives you protections that cannot be waived, those protections still apply.
        </p>

        <h2>14. Contact</h2>
        <p>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </article>
    </main>
  );
}
