import sanitizeHtml from "sanitize-html";

/**
 * The agent's HTML is served on a sandbox domain of its own, so scripts may
 * run: inline ones only, never from a URL. What the sanitizer still removes
 * is everything that would let a page collect or move secrets: forms and
 * text inputs (nothing to type into), frames, objects, event-handler
 * attributes (handlers go in the script), links to hosts outside the
 * allow-list, and any URL scheme other than http(s). The Content-Security-
 * Policy on the response (`siteCsp`) is the second line: no external
 * scripts, no requests anywhere but o1bot's own API, no images from
 * anywhere but the logo gateways. The o1bot blocks (`<o1bot-stats>` and
 * friends) pass through as empty custom elements and are filled by the
 * renderer afterwards.
 */

export const BLOCK_TAGS = ["o1bot-stats", "o1bot-buy", "o1bot-address", "o1bot-socials", "o1bot-logo", "o1bot-footer"] as const;
export type BlockTag = (typeof BLOCK_TAGS)[number];

/** Hosts a site may link to on its own; the brief's website host is added per site. */
export const DEFAULT_LINK_HOSTS = [
  "o1bot.exchange",
  "o1bot.app",
  "x.com",
  "twitter.com",
  "t.me",
  "telegram.me",
  "o1.exchange",
  "launch.o1.exchange",
  "docs.o1.exchange",
  "robinhoodchain.blockscout.com",
  "rh-scan.com",
  "basescan.org",
  "base.blockscout.com",
  "github.com",
] as const;

const TEXT_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "i", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "picture", "pre", "progress", "q", "s", "samp", "section",
  "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
  "img", "source", "script", "style",
];
const SVG_TAGS = ["svg", "g", "defs", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "symbol", "title", "desc"];

const SVG_ATTRS = [
  "viewBox", "width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy",
  "d", "points", "transform", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "font-size", "font-family",
  "font-weight", "text-anchor", "dominant-baseline", "preserveAspectRatio", "xmlns", "clip-path", "mask",
];

const ALLOWED_TAGS = [...TEXT_TAGS, ...SVG_TAGS, ...BLOCK_TAGS];

const ALLOWED_ATTRS: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": ["class", "id", "style", "title", "role", "aria-*", "data-*", "lang", "dir", "hidden", "tabindex"],
  a: ["href", "target", "rel", "name"],
  img: ["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"],
  source: ["srcset", "type", "media", "sizes"],
  button: ["type", "disabled"],
  canvas: ["width", "height"],
  progress: ["value", "max"],
  time: ["datetime"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  /** Inline only: no src, no type tricks. */
  script: [],
  style: [],
  "o1bot-buy": ["label"],
  "o1bot-logo": ["size"],
  ...Object.fromEntries(SVG_TAGS.map((t) => [t, SVG_ATTRS])),
};

export type SanitizeOptions = {
  /** Hosts (and their subdomains) a link may point at, on top of DEFAULT_LINK_HOSTS. */
  allowedLinkHosts?: string[];
};

export function linkHostAllowed(href: string, extra: string[] = []): boolean {
  if (/^#/.test(href) || /^\/[^/]/.test(href)) return true;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return [...DEFAULT_LINK_HOSTS, ...extra.map((h) => h.toLowerCase())].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function options(opts: SanitizeOptions): sanitizeHtml.IOptions {
  const extra = opts.allowedLinkHosts ?? [];
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ["http", "https"],
    allowedSchemesByTag: { img: ["https", "data"], source: ["https", "data"] },
    allowProtocolRelative: false,
    allowedIframeHostnames: [],
    allowVulnerableTags: true,
    disallowedTagsMode: "discard",
    // Tags whose content is dropped along with the tag.
    nonTextTags: ["textarea", "option", "noscript", "iframe", "object", "embed", "template", "head", "title", "form", "input", "select"],
    transformTags: {
      // Outbound links open in a new tab without a referrer; links to hosts outside the allow-list lose their href.
      a: (tagName, attribs) => {
        const href = attribs.href ?? "";
        if (href && !linkHostAllowed(href, extra)) {
          const { href: _dropped, target: _t, rel: _r, ...rest } = attribs;
          return { tagName, attribs: rest };
        }
        const external = /^https?:\/\//i.test(href);
        return { tagName, attribs: external ? { ...attribs, target: "_blank", rel: "noopener noreferrer" } : attribs };
      },
    },
  };
}

/** `<o1bot-buy/>` written as a void tag would swallow everything after it; make it an empty element first. */
function normalizeBlocks(html: string): string {
  const names = BLOCK_TAGS.join("|");
  return html.replace(new RegExp(`<(${names})(\\s[^>]*?)?\\s*/>`, "gi"), "<$1$2></$1>");
}

export function sanitizeSiteHtml(html: string, opts: SanitizeOptions = {}): string {
  return sanitizeHtml(normalizeBlocks(html), options(opts));
}

/** A stylesheet cannot run code; the only thing to stop is breaking out of the <style> element it is placed in. */
export function sanitizeSiteCss(css: string): string {
  return css.replace(/<\s*\/\s*style/gi, "<\\/style").replace(/<!--|-->/g, "");
}
