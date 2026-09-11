/**
 * A token site is two files the agent wrote (a body fragment and a
 * stylesheet) plus everything the renderer adds around them: the document
 * head, the base styles for the o1bot blocks, and the live numbers those
 * blocks show. Files are stored as `SiteFile[]` (the shape the editor and
 * the database use); `SiteFiles` is the same thing picked apart.
 */

export type SiteFile = { path: string; content: string };

export type SiteFiles = {
  /** Body fragment: no <html>, <head> or <body>; may contain o1bot blocks. */
  html: string;
  /** Stylesheet, injected into the head. */
  css: string;
};

export const HTML_FILE = "index.html";
export const CSS_FILE = "styles.css";

export function filesFromList(files: SiteFile[]): SiteFiles {
  const pick = (name: string) => files.find((f) => f.path.replace(/^\.?\//, "") === name)?.content ?? "";
  return { html: pick(HTML_FILE), css: pick(CSS_FILE) };
}

export function filesToList(files: SiteFiles): SiteFile[] {
  return [
    { path: HTML_FILE, content: files.html },
    { path: CSS_FILE, content: files.css },
  ];
}

export type SiteChain = "robinhood" | "base";

export type SiteMeta = {
  slug: string;
  /** Domain the sites hang under, e.g. "o1bot.app". */
  rootDomain: string;
  /** The app's own origin (the board, token pages, the API), e.g. "https://o1bot.exchange". */
  appUrl: string;
  /** Where a visitor can report a site; null hides the link. */
  reportEmail: string | null;
  /** Hosts, besides the defaults, the site may link to: the creator's website. */
  allowedLinkHosts: string[];
  title: string;
  description: string;
  /** BCP-47 tag for the document. */
  lang: string;
  /** Absolute URL of the image for link previews; the logo when there is one. */
  ogImage: string | null;
};

/** What the o1bot blocks show; read at request time, cached by the CDN. */
export type LiveData = {
  name: string;
  symbol: string;
  chain: SiteChain;
  /** Null while the launch has not confirmed. */
  token: string | null;
  status: "live" | "pending";
  priceUsd: number | null;
  mcapUsd: number | null;
  holders: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  pairSymbol: string | null;
  logoUrl: string | null;
  /** The o1bot token page, or the board while pending. */
  pageUrl: string;
  /** Where the Buy button goes. */
  buyUrl: string;
  explorerUrl: string | null;
  socials: { x: string | null; telegram: string | null; website: string | null };
  launchedAt: string | null;
};
