import { formatEther } from "viem";
import { fitsX, truncateForX, type ChainKey } from "@o1bot/shared";

/**
 * English source text for every reply. The pipeline localizes these into the
 * language of the user's post through the model; anything the model must
 * keep verbatim (addresses, handles, tickers, URLs, amounts) is protected in
 * `localizeReply`. Lengths are measured the way X measures them (every URL
 * counts as 23 characters), so a reply can carry a full token address and
 * two links.
 */

/** Explorer used in trade replies (the founder's pick for Robinhood Chain). */
export const TX_EXPLORER = "https://rh-scan.com/tx/";

/** o1's token page: the chain goes in the query string, not the path. */
export const O1_TOKEN_BASE = "https://launch.o1.exchange/token";
export const O1_CHAIN_QUERY = "?chain=4663";
const O1_CHAIN_ID: Record<ChainKey, number> = { robinhood: 4663, base: 8453 };
/** "Robinhood Chain" or "Base", for sentences. */
export const chainLabel = (chain: ChainKey | null | undefined): string => (chain === "base" ? "Base" : "Robinhood Chain");

export function clampReply(text: string): string {
  return truncateForX(text);
}

/** ETH amount rounded UP to 4 decimals, so a user who sends exactly this is never short. */
export function formatEthCeil(wei: bigint, decimals = 4): string {
  const unit = 10n ** BigInt(18 - decimals);
  const rounded = ((wei + unit - 1n) / unit) * unit;
  return formatEther(rounded);
}

export function o1TokenUrl(token: string, chain: ChainKey = "robinhood"): string {
  return `${O1_TOKEN_BASE}/${token.toLowerCase()}?chain=${O1_CHAIN_ID[chain]}`;
}

export function tokenPageUrl(siteUrl: string, token: string): string {
  return `${siteUrl}/token/${token}`;
}

export type SuccessInput = {
  ticker: string;
  /** Where the token launched; Robinhood when omitted. */
  chain?: ChainKey;
  name: string;
  pair: string;
  token: string;
  siteUrl: string;
  devBuyEth: string | null;
  feesTo: string | null;
  /** Set when `fees to` was requested but the redirect transaction failed. */
  feesToFailed?: string | null;
  /** The token site being built for this launch. */
  site?: string | null;
};

/**
 * Success replies carry no contract address (X blocks addresses posted by
 * young accounts) and a single link, the o1bot token page, which has the
 * chart, the swap and the address. Several phrasings are rotated,
 * picked from the token address so the same launch always gets the same
 * text, and the localizer turns it into the post's language.
 */
const SUCCESS_OPENERS: Array<(p: SuccessInput) => string> = [
  (p) => `$${p.ticker} is live on ${chainLabel(p.chain)}, paired with ${p.pair}. Chart, trades and swap:`,
  (p) => `Done. $${p.ticker} (${p.name}) just launched against ${p.pair}. Trade it here:`,
  (p) => `${p.name} is out. $${p.ticker} went live a moment ago on o1, paired with ${p.pair}. Watch it move:`,
  (p) => `Launched. $${p.ticker} is trading now, ${p.pair} pair, permanent liquidity. Everything about it:`,
  (p) => `Your token is live: $${p.ticker} (${p.name}), paired with ${p.pair}. Page with chart and swap:`,
  (p) => `$${p.ticker} now live. ${p.name} trades against ${p.pair} on o1 as of this block. Check it out:`,
];

export function successReply(p: SuccessInput): string {
  const link = tokenPageUrl(p.siteUrl, p.token);
  const index = Number.parseInt(p.token.slice(-4), 16) % SUCCESS_OPENERS.length;
  // A Base launch always says so, since Robinhood is what people expect.
  const opener = (p.chain === "base" ? SUCCESS_OPENERS.map((o) => o(p)).find((t) => t.includes("Base")) : undefined) ?? SUCCESS_OPENERS[Number.isNaN(index) ? 0 : index]!(p);
  const devBuy = p.devBuyEth ? `Dev buy of ${p.devBuyEth} ETH filled inside the launch.` : null;
  const fees = p.feesTo
    ? `Creator fees go to @${p.feesTo}, claimable after signing in with X at the link.`
    : p.feesToFailed
      ? `The fee redirect to @${p.feesToFailed} failed, so creator fees stay with you for now.`
      : null;
  const feesShort = p.feesTo ? `Creator fees go to @${p.feesTo}.` : fees;
  const site = p.site ? `Its website is being built at ${p.site}; I reply here when it is up.` : null;
  const siteShort = p.site ? `Site coming: ${p.site}` : null;

  const variants: string[][] = [
    [opener, link, [devBuy, fees, site].filter(Boolean).join(" ")],
    [opener, link, [devBuy, feesShort, site].filter(Boolean).join(" ")],
    [opener, link, [devBuy, feesShort, siteShort].filter(Boolean).join(" ")],
    [opener, link, [feesShort, siteShort].filter(Boolean).join(" ")],
    [opener, link, siteShort ?? ""],
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

  unsupportedChain: () => `Launches run on Robinhood Chain by default, or on Base when the command ends with "on base". Trades run on Robinhood; ETH can be bridged in from Base, Ethereum, Arbitrum or Optimism with "bridge 0.1 ETH from base".`,

  pairUnavailable: (pair: string, siteUrl: string, chainName = "Robinhood") => `${pair} is not a pair on o1's ${chainName} factory. Use ETH, USDG or a listed stock token. Pairs: ${siteUrl}/how-it-works`,

  tickerCollides: (ticker: string) => `$${ticker} is a stock token symbol on o1, so it cannot be a new ticker. Pick another one and post again.`,

  devBuyInvalid: () => `The dev buy amount must be a plain ETH number, for example "devbuy 0.05". Post again.`,

  devBuyTooLarge: (maxEth: string) => `The dev buy is capped at ${maxEth} ETH per launch. Lower it and post again.`,

  feesToRejected: (handle: string, reason: "reserved" | "invalid" | "not_found" | "suspended" | "unavailable" | "declined") =>
    reason === "reserved"
      ? `@${handle} cannot receive creator fees. Pick another account and post again.`
      : reason === "declined"
        ? `@${handle} has switched off receiving creator fees on o1bot. Pick another account or launch without "fees to".`
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

  // Trades from a post. Replies name the token page and, when a choice is needed, the contract addresses.
  tradeDisabled: (siteUrl: string) => `Trading from posts is off for your account. Turn it on and set your per-trade cap at ${siteUrl}/me, then post again.`,

  tradeUnknownToken: (ticker: string, siteUrl: string) => `I could not find $${ticker} on o1 Launchpad. Post again with its contract address, or pick one from the board at ${siteUrl}.`,

  tradeAmbiguous: (ticker: string, candidates: Array<{ name: string; token: string; liquidityUsd: number | null }>) => {
    const lines = candidates.map((c) => `${c.name || ticker}: ${c.token}${c.liquidityUsd !== null ? ` ($${Math.round(c.liquidityUsd).toLocaleString("en-US")} liquidity)` : ""}`);
    return `More than one $${ticker} on o1. Post again with the address of the one you mean:\n${lines.join("\n")}`;
  },

  tradeNotO1Pool: (ticker: string, siteUrl: string) => `$${ticker} is not an o1 Launchpad pool I can verify on chain, so I will not trade it. The board at ${siteUrl} lists what I can.`,

  tradeWrongUnit: (ticker: string, quoteSymbol: string) => `$${ticker} trades against ${quoteSymbol}, so say the amount in ${quoteSymbol}, for example "buy 5 ${quoteSymbol} of $${ticker}". Your wallet needs ${quoteSymbol} for it.`,

  tradeAntiSnipe: (ticker: string, secondsLeft: number) => `$${ticker} launched moments ago and o1's anti-snipe fee is still above 1%. Post again in ${Math.max(1, secondsLeft)} seconds and you pay the normal fee.`,

  tradeTooLarge: (capEth: string, siteUrl: string) => `That is above your per-trade cap of ${capEth} ETH (or its worth in the pool's asset). Lower the amount, or raise the cap at ${siteUrl}/me.`,

  tradeInsufficient: (shortfallEth: string, siteUrl: string) => `Your wallet is ${shortfallEth} ETH short for this trade, amount plus gas. Top up the wallet shown at ${siteUrl}/me and post again.`,

  tradeInsufficientAsset: (symbol: string, shortfall: string, siteUrl: string) => `Your wallet is ${shortfall} ${symbol} short for this buy. Send ${symbol} to the wallet shown at ${siteUrl}/me and post again.`,

  tradeNothingToSell: (ticker: string) => `Your wallet holds no $${ticker} to sell.`,

  tradeNoQuote: (ticker: string) => `I could not get a price for $${ticker} right now. Post again in a minute.`,

  tradeSlowDown: (retryAfterSeconds: number) => `One trade every few seconds per account. Try again in ${Math.max(1, retryAfterSeconds)} seconds.`,

  tradeDailyCap: () => `This account has reached today's trade limit. Try again tomorrow.`,

  // Bridges from a post, through Relay.
  bridgeTooLarge: (capEth: string) => `Bridges from a post have a cap of ${capEth} ETH per transfer. Lower the amount and post again.`,

  bridgeInsufficient: (chainName: string, shortfallEth: string, siteUrl: string) => `Your ${chainName} wallet is ${shortfallEth} ETH short for this transfer, amount plus gas. It is the same address as on Robinhood, shown at ${siteUrl}/me.`,

  bridgeFailed: (detail: string) => `The bridge did not go through (${detail}). Nothing left your wallet except gas, if any. Post again to retry.`,

  bridgeSuccess: (p: { chainName: string; amountIn: string; amountOut: string; fillTxHash: string | null; siteUrl: string }) => {
    const line = `Bridged ${p.amountIn} ETH from ${p.chainName} to your Robinhood wallet, ${p.amountOut} ETH landed.`;
    return p.fillTxHash ? `${line}\nTx: ${TX_EXPLORER}${p.fillTxHash}` : `${line}\n${p.siteUrl}/me`;
  },

  bridgePending: (p: { chainName: string; amountIn: string; depositTxHash: string; siteUrl: string }) =>
    `Your ${p.amountIn} ETH left ${p.chainName} and is still on its way to Robinhood through Relay. It usually lands within a minute; your balance is at ${p.siteUrl}/me. Deposit: ${p.depositTxHash.slice(0, 10)}…`,

  /** One reply for "buy … from base": the bridge line above the trade confirmation. */
  bridgedThen: (bridgeLine: string, tradeText: string) => `${bridgeLine}\n${tradeText}`,

  tradeFailed: (detail: string) => `The trade did not go through (${detail}). Nothing was spent except gas, if any. Post again to retry.`,

  /**
   * Trade confirmation: the amounts, the transaction on the explorer and the
   * token page. `safe` leaves the transaction link out, for the case where X
   * refuses the hash in the URL the way it refuses addresses.
   */
  tradeSuccess: (p: { side: "buy" | "sell"; ticker: string; quoteSymbol: string; amountIn: string; amountOut: string; token: string; siteUrl: string; txHash?: string | null }) => {
    const page = tokenPageUrl(p.siteUrl, p.token);
    const line = p.side === "buy" ? `Bought ${p.amountOut} $${p.ticker} for ${p.amountIn} ${p.quoteSymbol}.` : `Sold ${p.amountIn} $${p.ticker} for ${p.amountOut} ${p.quoteSymbol}.`;
    const safe = `${line}\n${page}`;
    const text = p.txHash ? `${line}\nTx: ${TX_EXPLORER}${p.txHash}\n${page}` : safe;
    return { text, safe };
  },

  // Token sites: a website the agent builds on a subdomain.
  siteInvalid: (slug: string, reason: "invalid" | "reserved") =>
    reason === "reserved"
      ? `"${slug}" cannot be a site name here. Pick another with "site <name>" and post again.`
      : `"${slug}" cannot be a subdomain: 3 to 32 letters, digits or hyphens, like "site catcoin". Post again.`,

  siteTaken: (slug: string, rootDomain: string) => `${slug}.${rootDomain} is already taken. Post again with another name, for example "site ${slug}coin".`,

  siteQueued: (ticker: string, url: string) => `On it. The site for $${ticker} is being built at ${url}; I reply here when it is live, usually within a couple of minutes.`,

  siteLive: (url: string, editUrl: string) => `Your site is live: ${url}\nChange the look or the copy any time at ${editUrl}`,

  siteFailed: (editUrl: string) => `The site could not be built this time. Retry from ${editUrl}, or post the site command again in a few minutes.`,

  siteNotCreator: (asked: string) => `Only the creator of ${asked.startsWith("0x") ? asked : `$${asked}`} can ask for its site.`,

  siteUnknownToken: (asked: string, siteUrl: string) => `I could not find ${asked.startsWith("0x") ? asked : `$${asked}`} among the tokens launched through o1bot, and I only build sites for those. Board: ${siteUrl}`,

  siteAmbiguous: (ticker: string, candidates: Array<{ name: string; token: string }>) => ({
    text: `You launched more than one $${ticker}. Post again with the address of the one you mean:\n${candidates.map((c) => `${c.name || ticker}: ${c.token}`).join("\n")}`,
    safe: `You launched more than one $${ticker} (${candidates.map((c) => c.name || ticker).join(", ")}). Post again with the address of the one you mean; your profile lists them.`,
  }),

  siteAlreadyLive: (ticker: string, url: string, editUrl: string) => `$${ticker} already has a site: ${url}\nEdit it at ${editUrl}`,

  // Questions answered from the data (kind ask). The model normally phrases the answer from the
  // same facts; these are the English stand-ins when it cannot, and the address-free variants.
  askNotRegistered: (siteUrl: string) => `I only show numbers for wallets linked to o1bot, and this account has none yet. Sign in with X at ${siteUrl}, then ask again.`,

  askUnavailable: (siteUrl: string) => `I could not read those numbers right now. The board at ${siteUrl} has them; ask me again in a minute.`,

  askStats: (p: { total: number; robinhood: number; base: number; scope: string | null; vol24: string; volAll: string; trades: string; siteUrl: string }) =>
    p.total === 0
      ? `No token has been launched through o1bot${p.scope ? ` on ${p.scope}` : ""} yet. The first one will show up at ${p.siteUrl}`
      : p.scope
        ? `${p.total} tokens launched through o1bot on ${p.scope}, ${p.vol24} traded in the last 24h, ${p.volAll} all time across ${p.trades} trades. Board: ${p.siteUrl}`
        : `${p.total} tokens launched through o1bot so far (${p.robinhood} on Robinhood Chain, ${p.base} on Base), ${p.vol24} traded in the last 24h, ${p.volAll} all time across ${p.trades} trades. Board: ${p.siteUrl}`,

  askNoTokens: (siteUrl: string) => `No token has been launched through o1bot yet, so there is nothing to rank. The first one will show up at ${siteUrl}.`,

  askTop: (rows: Array<{ ticker: string; vol24: string; change: string }>, siteUrl: string) =>
    `Most traded through o1bot in the last 24h: ${rows.map((r, i) => `${i + 1}) $${r.ticker} ${r.vol24}, ${r.change}`).join("; ")}. Board: ${siteUrl}`,

  askTokenUnknown: (asked: string, siteUrl: string) => `No ${asked.startsWith("0x") ? asked : `$${asked}`} was launched through o1bot, so I have no numbers for it. Every token the bot launched is on the board at ${siteUrl}.`,

  askTokenAmbiguous: (ticker: string, candidates: Array<{ name: string; token: string; vol24: string }>) => ({
    text: `More than one $${ticker} came through o1bot. Ask again with the address of the one you mean:\n${candidates.map((c) => `${c.name || ticker}: ${c.token} (${c.vol24} 24h)`).join("\n")}`,
    safe: `More than one $${ticker} came through o1bot (${candidates.map((c) => c.name || ticker).join(", ")}). Ask again with the address of the one you mean; the board lists them.`,
  }),

  askToken: (p: { ticker: string; name: string; chain: string; price: string; priceUsd: string; change: string; vol24: string; mcap: string; holders: string | null; creator: string | null; page: string }) =>
    `$${p.ticker} (${p.name}) on ${p.chain}: ${p.price} (${p.priceUsd}), ${p.change} in 24h, ${p.vol24} volume 24h, ${p.mcap} market cap${p.holders ? `, ${p.holders} holders` : ""}${p.creator ? `, launched by @${p.creator}` : ""}. ${p.page}`,

  askWallet: (p: { address: string; eth: string; quotes: string | null; tokens: string | null; fees: string | null; siteUrl: string }) => {
    const parts = [`ETH ${p.eth}`, p.quotes, p.tokens, p.fees].filter(Boolean).join("; ");
    const safe = `Your o1bot wallet: ${parts}. Address, details and deposit: ${p.siteUrl}/me`;
    const withAddress = `Your o1bot wallet ${p.address}: ${parts}. Details and deposit: ${p.siteUrl}/me`;
    // The address is worth 42 characters; when the balances leave no room for it, the profile link carries it instead.
    return { text: fitsX(withAddress) ? withAddress : safe, safe };
  },

  askLaunches: (p: { live: number; total: number; lines: string[]; siteUrl: string }) =>
    p.live === 0
      ? `No live launch from this account through o1bot yet${p.total ? ` (${p.total} attempted)` : ""}. Post the launch command and the first one shows up at ${p.siteUrl}/me`
      : `${p.live} live ${p.live === 1 ? "launch" : "launches"} from your account: ${p.lines.join("; ")}. All of them: ${p.siteUrl}/me`,

  askFees: (p: { claimable: string | null; earned: string | null; siteUrl: string }) =>
    `Creator fees claimable now: ${p.claimable ?? "none yet"}. Earned so far: ${p.earned ?? "none yet"}. Claim from your own wallet at ${p.siteUrl}/me`,

  askTrades: (p: { total: number; lines: string[]; siteUrl: string }) =>
    p.total === 0
      ? `No trade from a post on this account yet. Turn trading on at ${p.siteUrl}/me and post "buy 0.05 ETH of $CAT" for the first one.`
      : `${p.total} ${p.total === 1 ? "trade" : "trades"} from posts so far. Latest: ${p.lines.join("; ")}. History: ${p.siteUrl}/me`,
};
