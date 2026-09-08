import { formatEther } from "viem";
import { fitsX, truncateForX } from "@o1bot/shared";

/**
 * English source text for every reply. The pipeline localizes these into the
 * language of the user's post through the model; anything the model must
 * keep verbatim (addresses, handles, tickers, URLs, amounts) is protected in
 * `localizeReply`. Lengths are measured the way X measures them (every URL
 * counts as 23 characters), so a reply can carry a full token address and
 * two links.
 */

/** o1's token page: the chain goes in the query string, not the path. */
export const O1_TOKEN_BASE = "https://launch.o1.exchange/token";
export const O1_CHAIN_QUERY = "?chain=4663";

export function clampReply(text: string): string {
  return truncateForX(text);
}

/** ETH amount rounded UP to 4 decimals, so a user who sends exactly this is never short. */
export function formatEthCeil(wei: bigint, decimals = 4): string {
  const unit = 10n ** BigInt(18 - decimals);
  const rounded = ((wei + unit - 1n) / unit) * unit;
  return formatEther(rounded);
}

export function o1TokenUrl(token: string): string {
  return `${O1_TOKEN_BASE}/${token.toLowerCase()}${O1_CHAIN_QUERY}`;
}

export function tokenPageUrl(siteUrl: string, token: string): string {
  return `${siteUrl}/token/${token}`;
}

export type SuccessInput = {
  ticker: string;
  name: string;
  pair: string;
  token: string;
  siteUrl: string;
  devBuyEth: string | null;
  feesTo: string | null;
  /** Set when `fees to` was requested but the redirect transaction failed. */
  feesToFailed?: string | null;
};

/**
 * Success replies carry no contract address (X blocks addresses posted by
 * young accounts) and a single link, the o1bot token page, which has the
 * chart, the swap and the address. Several phrasings are rotated,
 * picked from the token address so the same launch always gets the same
 * text, and the localizer turns it into the post's language.
 */
const SUCCESS_OPENERS: Array<(p: SuccessInput) => string> = [
  (p) => `$${p.ticker} is live on Robinhood Chain, paired with ${p.pair}. Chart, trades and swap:`,
  (p) => `Done. $${p.ticker} (${p.name}) just launched against ${p.pair}. Trade it here:`,
  (p) => `${p.name} is out. $${p.ticker} went live a moment ago on o1, paired with ${p.pair}. Watch it move:`,
  (p) => `Launched. $${p.ticker} is trading now, ${p.pair} pair, permanent liquidity. Everything about it:`,
  (p) => `Your token is live: $${p.ticker} (${p.name}), paired with ${p.pair}. Page with chart and swap:`,
  (p) => `$${p.ticker} now live. ${p.name} trades against ${p.pair} on o1 as of this block. Check it out:`,
];

export function successReply(p: SuccessInput): string {
  const link = tokenPageUrl(p.siteUrl, p.token);
  const index = Number.parseInt(p.token.slice(-4), 16) % SUCCESS_OPENERS.length;
  const opener = SUCCESS_OPENERS[Number.isNaN(index) ? 0 : index]!(p);
  const devBuy = p.devBuyEth ? `Dev buy of ${p.devBuyEth} ETH filled inside the launch.` : null;
  const fees = p.feesTo
    ? `Creator fees go to @${p.feesTo}, claimable after signing in with X at the link.`
    : p.feesToFailed
      ? `The fee redirect to @${p.feesToFailed} failed, so creator fees stay with you for now.`
      : null;
  const feesShort = p.feesTo ? `Creator fees go to @${p.feesTo}.` : fees;

  const variants: string[][] = [
    [opener, link, [devBuy, fees].filter(Boolean).join(" ")],
    [opener, link, [devBuy, feesShort].filter(Boolean).join(" ")],
    [opener, link, feesShort ?? ""],
    [opener, link],
  ];
  for (const lines of variants) {
    const text = lines.filter((l) => l && l.length > 0).join("\n");
    if (fitsX(text)) return text;
  }
  return clampReply(`$${p.ticker} is live:\n${link}`);
}

export const replies = {
  notRegistered: (siteUrl: string) =>
    `Three steps first: 1) sign in with X at ${siteUrl} and allow signing, 2) send a little ETH on Robinhood Chain to the wallet it shows, 3) post the full launch command again. Then I launch from your wallet.`,

  unsupportedChain: () => `Only Robinhood Chain is supported right now. Leave the chain out or write "on robinhood" and post again.`,

  pairUnavailable: (pair: string, siteUrl: string) => `${pair} is not a pair on o1's Robinhood factory. Use ETH, USDG or a listed stock token. Pairs: ${siteUrl}/how-it-works`,

  tickerCollides: (ticker: string) => `$${ticker} is a stock token symbol on o1, so it cannot be a new ticker. Pick another one and post again.`,

  devBuyInvalid: () => `The dev buy amount must be a plain ETH number, for example "devbuy 0.05". Post again.`,

  devBuyTooLarge: (maxEth: string) => `The dev buy is capped at ${maxEth} ETH per launch. Lower it and post again.`,

  feesToRejected: (handle: string, reason: "reserved" | "invalid" | "not_found" | "suspended" | "unavailable") =>
    reason === "reserved"
      ? `@${handle} cannot receive creator fees. Pick another account and post again.`
      : reason === "suspended"
        ? `@${handle} is suspended on X, so it cannot receive creator fees.`
        : reason === "unavailable"
          ? `I could not check @${handle} on X right now. Post again in a minute.`
          : `I could not find @${handle} on X. Check the handle and post again.`,

  slowDown: (reason: "cooldown" | "daily_cap", retryAfterSeconds: number, cooldownSeconds: number) =>
    reason === "cooldown"
      ? `One launch per account every ${Math.max(1, Math.round(cooldownSeconds / 60))} minutes. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} min.`
      : `This account has reached today's launch limit. Try again tomorrow.`,

  insufficient: (shortfallEth: string, address: string) =>
    `Your wallet is ${shortfallEth} ETH short for this launch. Send ETH on Robinhood Chain to ${address}, then post again.`,

  insufficientUnknown: (address: string) => `Your wallet does not hold enough ETH for this launch. Send ETH on Robinhood Chain to ${address}, then post again.`,

  insufficientSafe: (shortfallEth: string, siteUrl: string) =>
    `Your wallet is ${shortfallEth} ETH short for this launch. Sign in at ${siteUrl} to see your deposit address, top up, then post again.`,

  insufficientSafeUnknown: (siteUrl: string) => `Your wallet does not hold enough ETH for this launch. Sign in at ${siteUrl} to see your deposit address, top up, then post again.`,

  devBuyNoRoute: (pair: string) => `There is no liquid route from ETH to ${pair} for a dev buy right now. Post again without "devbuy" to launch anyway.`,

  launchFailed: (detail: string) => `The launch did not go through (${detail}). Nothing was spent except gas, if any. Post the full launch command again to retry.`,

  success: successReply,
};
