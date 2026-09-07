import type { Metadata } from "next";
import { BOT_HANDLE, CONTACT_EMAIL, LEGAL_UPDATED, SITE_NAME } from "@/components/links";

export const metadata: Metadata = {
  title: `Privacy policy — ${SITE_NAME}`,
  description: `What ${SITE_NAME} collects when you link X, create a wallet, and launch a token from a post, and who processes it.`,
};

export default function PrivacyPage() {
  return (
    <main className="wrap">
      <article className="legal">
        <p className="eyebrow">Legal</p>
        <h1>
          <span className="grad">Privacy policy</span>
        </h1>
        <p className="meta">Last updated {LEGAL_UPDATED}</p>

        <p>
          {SITE_NAME} ("we", "us") runs the X bot @{BOT_HANDLE} and the website at {SITE_NAME}. This policy explains what we collect when you use them, why, who else processes it, and what you can ask us to do. If anything here is unclear, write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>

        <h2>What we collect</h2>
        <h3>When you sign in with X</h3>
        <p>
          Sign-in is handled by Privy. We receive your X user id, username, display name, and profile picture URL. We use the user id as your stable identity, because usernames change.
        </p>
        <h3>Your wallet</h3>
        <p>
          Privy creates an embedded Ethereum wallet for your account. We store the wallet address and a Privy wallet identifier so the bot can request signatures with your permission. We never receive or store your private key. We also record whether you granted the bot delegated signing and when.
        </p>
        <h3>Public posts that mention the bot</h3>
        <p>
          When a post on X mentions @{BOT_HANDLE}, we store the post id, its text, the author's X user id and username, the URL of the first attached image, the language we detected, our parsed interpretation of the command, and the reply we sent. Posts that only mention the bot in passing are stored the same way so we can avoid replying twice.
        </p>
        <h3>Launches and signed transactions</h3>
        <p>
          For every launch we keep the token address, pool id, pair, amounts, transaction hashes, and timestamps. For every transaction the bot signs from your wallet we keep an audit record: the post id, your X user id, the wallet address, the destination contract, the kind of transaction, and a hash of the calldata.
        </p>
        <h3>Technical data</h3>
        <p>
          Our servers log requests to the website and API (IP address, user agent, timestamps, errors) to keep the service secure and working. These logs are kept for a short period and are not used for advertising.
        </p>

        <h2>How we use it</h2>
        <ul>
          <li>To run the bot: read your command, check your account and balance, prepare and submit the launch, and reply to your post.</li>
          <li>To prevent abuse: rate limits per account, refusing reserved handles as fee recipients, and blocking spam.</li>
          <li>To show launches on the website: the board and token pages display the launching post and the account behind it.</li>
          <li>To comply with the law and respond to lawful requests.</li>
        </ul>
        <p>We do not sell your data and we do not use it for advertising.</p>

        <h2>What becomes public and permanent</h2>
        <p>
          Blockchain transactions are public and cannot be deleted. Token metadata, including the token image and a record of the launching post (your X handle, X user id, and the post id), is pinned to IPFS, which is public and effectively permanent. Replies the bot posts on X are public. Think of a launch as publishing: do not include anything in a launch post or image that you would not want to be public forever.
        </p>

        <h2>Who else processes your data</h2>
        <ul>
          <li>
            <b>Privy</b> handles X sign-in and custody of the embedded wallet's key material under its own security model and privacy policy.
          </li>
          <li>
            <b>X (Twitter)</b> provides the posts that mention the bot and delivers our replies, under X's terms and privacy policy.
          </li>
          <li>
            <b>Anthropic</b> processes the text of posts that mention the bot so our parser can turn them into launch commands. We send the post text, the author's handle, and whether an image is attached. We do not send wallet keys or balances.
          </li>
          <li>
            <b>Pinata (IPFS)</b> stores token images and metadata. Anything pinned there is public.
          </li>
          <li>
            <b>RPC and hosting providers</b> relay blockchain transactions and host the website; they see the technical data described above.
          </li>
        </ul>
        <p>We only share what each provider needs to do its job.</p>

        <h2>Cookies and local storage</h2>
        <p>
          The website uses Privy's session storage to keep you signed in. We do not use advertising cookies or third-party trackers.
        </p>

        <h2>How long we keep data</h2>
        <ul>
          <li>Account and wallet records: for as long as your account exists.</li>
          <li>Posts, launches, and the signing audit log: indefinitely, because they document who launched what and protect users and us against disputes.</li>
          <li>Server logs: up to 30 days.</li>
        </ul>

        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, export, or delete the personal data we hold, and to object to some uses of it. Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the email or X account concerned. We will delete off-chain data we control. We cannot alter or remove anything already on a blockchain or on IPFS, and we cannot delete data held by Privy, X, or Anthropic on your behalf; contact them directly for that.
        </p>

        <h2>Age</h2>
        <p>The service is for adults. If you are under 18, or under the age of majority where you live, do not use it.</p>

        <h2>Changes</h2>
        <p>
          We will update this page when the service changes in a way that affects your data, and we will change the date at the top. Material changes are announced from @{BOT_HANDLE}.
        </p>

        <h2>Contact</h2>
        <p>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </article>
    </main>
  );
}
