import { formatPct, formatUsd } from "@o1bot/market";
import { BLOCK_TAGS, sanitizeSiteCss, sanitizeSiteHtml, type BlockTag } from "./sanitize";
import { siteUrl } from "./slug";
import type { LiveData, SiteFiles, SiteMeta } from "./types";

/**
 * Turns the agent's files into the document that is served: o1bot owns the
 * head (title, description, link preview, canonical URL, the policy, base
 * styles), sanitizes the body, and fills the o1bot blocks with the live
 * numbers. The same function renders the editor preview, so what the
 * creator sees is what visitors get, policy included: the Content-Security-
 * Policy goes into the document as a meta element as well as on the
 * response, and a meta policy applies inside a preview frame too.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Three significant digits in plain notation for sub-dollar prices; K/M/B above. */
function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1) return formatUsd(n);
  if (n === 0) return "$0";
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.min(18, Math.max(0, 2 - exp));
  return `$${n.toFixed(decimals).replace(/\.?0+$/, "")}`;
}

const count = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
const chainLabel = (chain: LiveData["chain"]) => (chain === "base" ? "Base" : "Robinhood Chain");
const originOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** Styles for the blocks. Namespaced, themeable through CSS variables the agent may set on :root. */
export const BASE_CSS = `
.o1bot-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:0;padding:0;list-style:none}
.o1bot-stat{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:var(--o1bot-radius,14px);background:var(--o1bot-tile,rgba(127,127,127,.12));border:1px solid var(--o1bot-line,rgba(127,127,127,.25))}
.o1bot-stat-label{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;opacity:.7}
.o1bot-stat-value{font-size:1.35rem;font-weight:700;line-height:1.15}
.o1bot-stat-delta{font-size:.8rem;opacity:.8}
.o1bot-stat-delta.up{color:var(--o1bot-up,#2fbf71)}
.o1bot-stat-delta.down{color:var(--o1bot-down,#e5484d)}
.o1bot-buy{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:14px 26px;border-radius:var(--o1bot-radius,14px);background:var(--o1bot-accent,#6c5ce7);color:var(--o1bot-accent-text,#fff);font-weight:700;text-decoration:none;border:0}
.o1bot-buy:hover{filter:brightness(1.08)}
.o1bot-address{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:10px 14px;border-radius:var(--o1bot-radius,14px);background:var(--o1bot-tile,rgba(127,127,127,.12));border:1px solid var(--o1bot-line,rgba(127,127,127,.25));color:inherit;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;word-break:break-all}
.o1bot-socials{display:flex;flex-wrap:wrap;gap:10px;margin:0;padding:0;list-style:none}
.o1bot-socials a{display:inline-flex;align-items:center;padding:10px 16px;border-radius:999px;border:1px solid var(--o1bot-line,rgba(127,127,127,.35));color:inherit;text-decoration:none;font-weight:600}
.o1bot-socials a:hover{background:var(--o1bot-tile,rgba(127,127,127,.12))}
.o1bot-logo{display:block;border-radius:24%;object-fit:cover}
.o1bot-footer{font-size:.85rem;opacity:.7}
.o1bot-footer a{color:inherit}
`;

type Block = (attrs: Record<string, string>, live: LiveData, meta: SiteMeta) => string;

const BLOCKS: Record<BlockTag, Block> = {
  "o1bot-stats": (_a, live) => {
    const delta = live.change24hPct === null ? "" : `<span class="o1bot-stat-delta ${live.change24hPct >= 0 ? "up" : "down"}">${escapeHtml(formatPct(live.change24hPct))} 24h</span>`;
    const tile = (key: string, label: string, value: string, extra = "") => `<div class="o1bot-stat" data-stat="${key}"><span class="o1bot-stat-label">${label}</span><span class="o1bot-stat-value">${value}</span>${extra}</div>`;
    if (live.status === "pending") {
      return `<div class="o1bot-stats">${tile("price", "Price", "soon")}${tile("mcap", "Market cap", "soon")}${tile("holders", "Holders", "soon")}${tile("volume", "24h volume", "soon")}</div>`;
    }
    return `<div class="o1bot-stats">${tile("price", "Price", escapeHtml(usd(live.priceUsd)), delta)}${tile("mcap", "Market cap", escapeHtml(usd(live.mcapUsd)))}${tile("holders", "Holders", escapeHtml(count(live.holders)))}${tile("volume", "24h volume", escapeHtml(usd(live.volume24hUsd)))}</div>`;
  },
  "o1bot-buy": (attrs, live) => {
    const label = attrs.label?.trim() || (live.status === "pending" ? `$${live.symbol} launches soon` : `Buy $${live.symbol}`);
    return `<a class="o1bot-buy" href="${escapeHtml(live.buyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  },
  "o1bot-address": (_a, live) => {
    if (!live.token) return `<span class="o1bot-address">Contract address: published at launch</span>`;
    const inner = `<code data-address="${escapeHtml(live.token)}">${escapeHtml(live.token)}</code>`;
    return live.explorerUrl ? `<a class="o1bot-address" href="${escapeHtml(live.explorerUrl)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="o1bot-address">${inner}</span>`;
  },
  "o1bot-socials": (_a, live) => {
    const links: Array<[string, string | null]> = [
      ["X", live.socials.x],
      ["Telegram", live.socials.telegram],
      ["Website", live.socials.website],
      ["Chart & swap", live.pageUrl],
      ["Explorer", live.explorerUrl],
    ];
    const items = links.filter((l): l is [string, string] => Boolean(l[1])).map(([label, href]) => `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a></li>`);
    return `<ul class="o1bot-socials">${items.join("")}</ul>`;
  },
  "o1bot-logo": (attrs, live) => {
    if (!live.logoUrl) return "";
    const size = attrs.size === "sm" ? 96 : attrs.size === "lg" ? 240 : 160;
    return `<img class="o1bot-logo" src="${escapeHtml(live.logoUrl)}" alt="${escapeHtml(live.name)} logo" width="${size}" height="${size}" loading="lazy" decoding="async">`;
  },
  "o1bot-footer": (_a, live, meta) => {
    const appHost = meta.appUrl.replace(/^https?:\/\//, "");
    const launched = live.status === "pending" ? "is launching" : "was launched";
    const report = meta.reportEmail ? ` <a href="mailto:${escapeHtml(meta.reportEmail)}?subject=${encodeURIComponent(`Report site ${meta.slug}.${meta.rootDomain}`)}">Report this site</a>.` : "";
    return `<p class="o1bot-footer">$${escapeHtml(live.symbol)} ${launched} through <a href="${escapeHtml(meta.appUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(appHost)}</a> on ${chainLabel(live.chain)}. This page was written by its creator with an AI agent; nothing here is financial advice.${report}</p>`;
  },
};

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** Replace every o1bot block in already-sanitized HTML with its rendered markup. */
export function renderBlocks(html: string, live: LiveData, meta: SiteMeta): string {
  const names = BLOCK_TAGS.join("|");
  return html.replace(new RegExp(`<(${names})(\\s[^>]*)?>[\\s\\S]*?</\\1>`, "gi"), (_m, tag: string, attrs = "") => BLOCKS[tag.toLowerCase() as BlockTag](parseAttrs(attrs), live, meta));
}

export type CspInput = { rootDomain: string; appUrl: string; imageOrigins?: Array<string | null | undefined> };

/**
 * What a site may do. Scripts: inline only, never from a URL. Requests:
 * o1bot's own API and nothing else, so a page cannot send anything
 * anywhere. Images: the logo gateways and the app. No frames, forms,
 * objects, media or workers. `meta` leaves out the directives a <meta>
 * policy cannot carry.
 */
export function siteCsp(input: CspInput, opts: { meta?: boolean } = {}): string {
  const app = originOf(input.appUrl) ?? input.appUrl;
  const images = [...new Set(["data:", app, "https://gateway.pinata.cloud", ...(input.imageOrigins ?? []).map(originOf).filter((o): o is string => o !== null)])];
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    `img-src ${images.join(" ")}`,
    `connect-src ${app}`,
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    ...(opts.meta ? [] : [`frame-ancestors 'self' ${app}`]),
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

export function renderSite(files: SiteFiles, meta: SiteMeta, live: LiveData): string {
  const body = renderBlocks(sanitizeSiteHtml(files.html, { allowedLinkHosts: meta.allowedLinkHosts }), live, meta);
  const css = sanitizeSiteCss(files.css);
  const url = `${siteUrl(meta.slug, meta.rootDomain)}/`;
  const csp = siteCsp({ rootDomain: meta.rootDomain, appUrl: meta.appUrl, imageOrigins: [live.logoUrl, meta.ogImage] }, { meta: true });
  const head = [
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    meta.ogImage ? `<meta property="og:image" content="${escapeHtml(meta.ogImage)}">` : "",
    `<meta name="twitter:card" content="summary">`,
    live.logoUrl ? `<link rel="icon" href="${escapeHtml(live.logoUrl)}">` : "",
    live.status === "pending" ? `<meta name="robots" content="noindex">` : "",
    `<style>${BASE_CSS}</style>`,
    `<style>\n${css}\n</style>`,
  ]
    .filter(Boolean)
    .join("\n");
  return `<!doctype html>\n<html lang="${escapeHtml(meta.lang || "en")}">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** A minimal page for a slug that has no published site (reserved, generating, failed, suspended, unknown). */
export function placeholderPage(slug: string, rootDomain: string, state: "reserved" | "generating" | "failed" | "suspended" | "unknown", appUrl = "https://o1bot.exchange"): string {
  const line =
    state === "unknown"
      ? "There is no site here."
      : state === "suspended"
        ? "This site was taken down."
        : state === "failed"
          ? "This site could not be built yet. Its creator can retry from the editor."
          : "This site is being built. Check back in a minute.";
  const appHost = appUrl.replace(/^https?:\/\//, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(slug)}.${escapeHtml(rootDomain)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0E141D;color:#e6edf6;font:16px/1.5 system-ui,sans-serif}main{max-width:420px;padding:32px;text-align:center}a{color:#7aa2ff}</style></head>
<body><main><h1 style="font-size:1.25rem">${escapeHtml(slug)}.${escapeHtml(rootDomain)}</h1><p>${line}</p><p><a href="${escapeHtml(appUrl)}">${escapeHtml(appHost)}</a></p></main></body></html>
`;
}
