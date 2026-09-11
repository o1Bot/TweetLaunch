/**
 * Subdomain labels for token sites. A slug is a DNS label: lowercase letters,
 * digits and hyphens, 3 to 32 characters, no hyphen at either end. Labels the
 * app or the infrastructure could need are reserved.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 32;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "api", "app", "apps", "docs", "doc", "mail", "email", "smtp", "imap", "pop", "mx", "ns1", "ns2", "ftp",
  "admin", "root", "me", "token", "tokens", "launch", "launches", "site", "sites", "o1", "o1bot", "o1exchange",
  "static", "assets", "cdn", "img", "images", "status", "health", "help", "support", "bot", "dev", "staging",
  "test", "preview", "vercel", "ipfs", "blog", "news", "shop", "login", "logout", "auth", "account", "wallet",
  "swap", "trade", "trades", "bridge", "robinhood", "base", "eth", "usdg", "usdc", "x", "twitter", "telegram",
  "discord", "privy", "pinata", "relay", "embed", "widget", "widgets", "share", "go", "link", "links",
]);

/** Lowercase, strip a leading $, turn spaces and underscores into hyphens, drop everything else. */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^\$/, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type SlugCheck = { ok: true; slug: string } | { ok: false; slug: string; reason: "invalid" | "reserved" };

export function checkSlug(raw: string): SlugCheck {
  const slug = normalizeSlug(raw);
  if (!SLUG_RE.test(slug)) return { ok: false, slug, reason: "invalid" };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, slug, reason: "reserved" };
  return { ok: true, slug };
}

/** The default slug for a launch is the ticker; short tickers are padded with "-token" so "o1" or "x" still get a site. */
export function slugFromTicker(ticker: string): SlugCheck {
  const base = normalizeSlug(ticker);
  const first = checkSlug(base);
  if (first.ok) return first;
  return checkSlug(`${base}-token`);
}

export function siteUrl(slug: string, rootDomain: string): string {
  return `https://${slug}.${rootDomain}`;
}

/** The slug in a host name under the root domain, or null for the apex, www and foreign hosts. */
export function slugFromHost(host: string, rootDomain: string): string | null {
  const h = host.toLowerCase().split(":")[0] ?? "";
  const root = rootDomain.toLowerCase();
  if (!h.endsWith(`.${root}`)) return null;
  const label = h.slice(0, -(root.length + 1));
  if (!label || label.includes(".") || label === "www") return null;
  return SLUG_RE.test(label) ? label : null;
}
