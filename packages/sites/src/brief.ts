import type { SiteChain } from "./types";

/**
 * Everything the agent is told about a token before it writes the site. The
 * bot builds this from the launch (and, for a token that already trades,
 * from its metadata); nothing in it is guessed. Numbers that change (price,
 * holders) are never part of the brief: the blocks render those live.
 */
export type SiteBrief = {
  slug: string;
  rootDomain: string;
  name: string;
  symbol: string;
  chain: SiteChain;
  pairSymbol: string;
  /** The creator's description from the launch, verbatim; null when none was given. */
  description: string | null;
  /** The post that launched the token, for its tone and any story it tells. */
  originPost: string | null;
  creatorHandle: string | null;
  /** Public https URL of the logo; the only raster image the site may use. */
  logoUrl: string | null;
  /** Hex colours taken from the logo, most present first; null when unknown. */
  palette: string[] | null;
  socials: { x: string | null; telegram: string | null; website: string | null };
  /** BCP-47 tag of the language the copy should be written in. */
  language: string;
};

const chainLabel = (chain: SiteChain) => (chain === "base" ? "Base" : "Robinhood Chain");

/** The brief as the model reads it: one fact per line, plus the fixed o1 facts every site may state. */
export function briefText(b: SiteBrief): string {
  const lines = [
    `Token name: ${b.name}`,
    `Ticker: $${b.symbol}`,
    `Chain: ${chainLabel(b.chain)}`,
    `Paired asset (what it trades against and what fees are paid in): ${b.pairSymbol}`,
    `Site address: https://${b.slug}.${b.rootDomain}`,
    `Creator's description: ${b.description ? JSON.stringify(b.description) : "none given"}`,
    `The post that launched it: ${b.originPost ? JSON.stringify(b.originPost) : "none (launched from the web form)"}`,
    `Creator: ${b.creatorHandle ? `@${b.creatorHandle} on X` : "unknown"}`,
    `Logo: ${b.logoUrl ? `${b.logoUrl} (square image; use it with <o1bot-logo>)` : "none; use typography, never a placeholder image"}`,
    `Colours found in the logo, most present first: ${b.palette?.length ? b.palette.join(", ") : "unknown; choose a palette that fits the name"}`,
    `Links: X ${b.socials.x ?? "none"}; Telegram ${b.socials.telegram ?? "none"}; Website ${b.socials.website ?? "none"}`,
    `Language for all copy: ${b.language}`,
    "",
    "Facts about every o1 Launchpad token (true for this one, may be stated, never embellished):",
    "- The entire supply went into a permanent Uniswap v4 pool at launch. No presale, no team allocation, no minting later.",
    "- Every trade pays a 1% swap fee; half of it goes to the creator, in the paired asset.",
    "- The first 20 seconds after launch carry a decaying anti-snipe fee, so nobody could front-run the launch.",
    `- It trades on ${chainLabel(b.chain)} through o1bot.exchange, where the chart, trades and swap live.`,
  ];
  return lines.join("\n");
}
