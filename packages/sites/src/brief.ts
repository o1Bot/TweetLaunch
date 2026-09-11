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
  /** The app's origin, where the read-only token API lives. */
  apiOrigin: string;
  name: string;
  symbol: string;
  chain: SiteChain;
  pairSymbol: string;
  /** Contract address once the launch confirmed; the API is keyed by it. */
  tokenAddress: string | null;
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
  /** The visual idea this build follows; picked per token, rotated on every rebuild. */
  direction: string;
};

/**
 * Left to itself the model designs the same dark page with one accent for
 * every token. A direction assigned per token, and changed on every rebuild,
 * is what makes two sites look like two sites.
 */
export const ART_DIRECTIONS: readonly string[] = [
  "Bold editorial: a huge serif display headline, black on off-white paper, thin rules, generous margins, one accent colour from the logo used sparingly, no cards, no gradients.",
  "Playful cartoon: big rounded shapes, thick outlines, saturated logo colours on a bright background, bouncy CSS animations, oversized buttons, hand-drawn feel through inline SVG blobs.",
  "Luxury minimal: near-black or cream background, one metallic accent, small caps, wide letter-spacing, lots of air, thin dividers, the logo small and centred, nothing moves except a slow fade-in.",
  "Retro terminal: monospace everything, dark screen with a phosphor accent from the logo, blinking cursor, box-drawing borders, stats rendered like a readout, scanline overlay in CSS.",
  "Sticker chaos: overlapping tilted stickers and badges built from inline SVG and CSS transforms, loud logo colours, marquee text, a poster more than a page, everything slightly off-grid on purpose.",
  "Swiss grid: strict 12-column layout, Helvetica-like sans, red-black-white or the logo's primary on white, large numerals for the stats, rules and alignment do the work, no decoration.",
  "Neon arcade: deep dark background, two neon colours from the logo glowing (text-shadow, box-shadow), pixel-style headings, animated gradient border on the buy button, a starfield on canvas.",
  "Paper zine: textured paper background via CSS gradients, cut-out photo-collage feel using the logo in a torn frame, typewriter body, marker-style highlights behind key words, staggered layout.",
  "Soft pastel: pale gradient background in the logo's tints, rounded 24px cards with soft shadows, friendly humanist sans, gentle floating animation on the logo, calm and cute.",
  "Brutalist web: system font at huge sizes, raw borders, high-contrast blocks of the logo's colours, underlined links, visible grid lines, no rounded corners, no shadows, unapologetic.",
  "Glass and depth: layered translucent panels over a colourful blurred background made from the logo's palette, backdrop-filter, light borders, floating stats, the logo as a glowing centrepiece.",
  "Comic strip: panels with thick borders, halftone-dot backgrounds in CSS, speech-bubble callouts for the tagline and the how-to-buy steps, punchy display type, primary colours from the logo.",
];

/** A stable choice per token; `salt` moves to another direction (the next rebuild). */
export function directionFor(seed: string, salt = 0): string {
  let h = 2166136261;
  for (const ch of seed.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return ART_DIRECTIONS[(h + salt) % ART_DIRECTIONS.length]!;
}

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
    `Contract address: ${b.tokenAddress ?? "not known yet (the address block shows it once it is)"}`,
    `Token page with chart and swap: ${b.tokenAddress ? `${b.apiOrigin}/token/${b.tokenAddress}` : b.apiOrigin}`,
    `Language for all copy: ${b.language}`,
    `Art direction for this build (follow it; it is what makes this site look like this token and not like the last one): ${b.direction}`,
    "",
    ...(b.tokenAddress
      ? [
          "Read-only JSON API a script on the page may call (CORS is open for this site; nothing else may be fetched):",
          `- GET ${b.apiOrigin}/api/token/${b.tokenAddress} -> { data: { name, symbol, stats: { priceUsd, priceQuote, mcapUsd, volume24hUsd, volumeAllUsd, change24hPct }, tradeCount, quoteSymbol, launchedAt, trades: [{ time, side, amountToken, amountQuote, priceQuote }] } }; numbers may be null before the first trade.`,
          `- GET ${b.apiOrigin}/api/token/${b.tokenAddress}/holders -> { total, holders: [{ address, balance, percent }] }`,
          `- GET ${b.apiOrigin}/api/token/${b.tokenAddress}/candles?tf=15m -> { data: [{ t, o, h, l, c, v }], quoteSymbol } (t = bucket start in unix seconds, o/h/l/c = price in the paired asset, v = volume; tf: 1m, 5m, 15m, 1h, 4h, 1d)`,
          "",
        ]
      : []),
    "Facts about every o1 Launchpad token (true for this one, may be stated, never embellished):",
    "- The entire supply went into a permanent Uniswap v4 pool at launch. No presale, no team allocation, no minting later.",
    "- Every trade pays a 1% swap fee; half of it goes to the creator, in the paired asset.",
    "- The first 20 seconds after launch carry a decaying anti-snipe fee, so nobody could front-run the launch.",
    `- It trades on ${chainLabel(b.chain)} through o1bot.exchange, where the chart, trades and swap live.`,
  ];
  return lines.join("\n");
}
