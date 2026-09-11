import sanitizeHtml from "sanitize-html";

/**
 * The agent's HTML is served under o1bot's own domain, so nothing in it may
 * run: no scripts, no event handlers, no javascript: URLs, no frames, no
 * forms. This is the first line; the Content-Security-Policy on the response
 * (`siteCsp`) is the second. Inline styles and a subset of SVG are allowed,
 * since CSS cannot execute code and the CSP bounds what it can fetch. The
 * o1bot blocks (`<o1bot-stats>` and friends) pass through as empty custom
 * elements and are filled by the renderer afterwards.
 */

export const BLOCK_TAGS = ["o1bot-stats", "o1bot-buy", "o1bot-address", "o1bot-socials", "o1bot-logo", "o1bot-footer"] as const;
export type BlockTag = (typeof BLOCK_TAGS)[number];

const TEXT_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "i", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "samp", "section",
  "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
  "img", "source",
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
  "*": ["class", "id", "style", "title", "role", "aria-*", "data-*", "lang", "dir", "hidden"],
  a: ["href", "target", "rel", "name"],
  img: ["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"],
  source: ["srcset", "type", "media", "sizes"],
  time: ["datetime"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  "o1bot-buy": ["label"],
  "o1bot-logo": ["size"],
  ...Object.fromEntries(SVG_TAGS.map((t) => [t, SVG_ATTRS])),
};

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRS,
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["https", "data"], source: ["https", "data"] },
  allowProtocolRelative: false,
  allowedIframeHostnames: [],
  disallowedTagsMode: "discard",
  // Tags whose content is dropped along with the tag.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "template", "head", "title"],
  // Every outbound link opens in a new tab without a referrer or window handle.
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const external = /^https?:\/\//i.test(href);
      return { tagName, attribs: external ? { ...attribs, target: "_blank", rel: "noopener noreferrer" } : attribs };
    },
  },
};

/** `<o1bot-buy/>` written as a void tag would swallow everything after it; make it an empty element first. */
function normalizeBlocks(html: string): string {
  const names = BLOCK_TAGS.join("|");
  return html.replace(new RegExp(`<(${names})(\\s[^>]*?)?\\s*/>`, "gi"), "<$1$2></$1>");
}

export function sanitizeSiteHtml(html: string): string {
  return sanitizeHtml(normalizeBlocks(html), OPTIONS);
}

/** A stylesheet cannot run code; the only thing to stop is breaking out of the <style> element it is placed in. */
export function sanitizeSiteCss(css: string): string {
  return css.replace(/<\s*\/\s*style/gi, "<\\/style").replace(/<!--|-->/g, "");
}
