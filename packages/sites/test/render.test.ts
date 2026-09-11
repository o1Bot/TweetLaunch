import { describe, expect, it } from "vitest";
import { placeholderPage, renderBlocks, renderSite, siteCsp } from "../src/render";
import type { LiveData, SiteMeta } from "../src/types";

const meta: SiteMeta = {
  slug: "cat",
  rootDomain: "o1bot.app",
  appUrl: "https://o1bot.exchange",
  reportEmail: "hello@o1bot.exchange",
  allowedLinkHosts: ["cashcat.xyz"],
  title: "Cash Cat ($CAT)",
  description: "The cat that pays.",
  lang: "en",
  ogImage: "https://gateway.pinata.cloud/ipfs/logo",
};

const live: LiveData = {
  name: "Cash Cat",
  symbol: "CAT",
  chain: "robinhood",
  token: "0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  status: "live",
  priceUsd: 0.000842,
  mcapUsd: 841600,
  holders: 2420,
  volume24hUsd: 813800,
  change24hPct: -43.9,
  pairSymbol: "ETH",
  logoUrl: "https://moccasin-wooden-ptarmigan-419.mypinata.cloud/ipfs/logo",
  pageUrl: "https://o1bot.exchange/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  buyUrl: "https://o1bot.exchange/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01#swap",
  explorerUrl: "https://rh-scan.com/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  socials: { x: "https://x.com/cashcat", telegram: null, website: "https://cashcat.xyz" },
  launchedAt: "2026-09-08T10:00:00.000Z",
};

describe("renderBlocks", () => {
  it("fills the stats block with formatted live numbers, tagged for scripts to refresh", () => {
    const out = renderBlocks("<o1bot-stats></o1bot-stats>", live, meta);
    expect(out).toContain('data-stat="price"');
    expect(out).toContain("$0.000842");
    expect(out).toContain("$841.6K");
    expect(out).toContain("2,420");
    expect(out).toContain("$813.8K");
    expect(out).toContain('class="o1bot-stat-delta down">-43.9% 24h');
  });

  it("renders the buy, address, socials, logo and footer blocks", () => {
    const out = renderBlocks(`<o1bot-buy label="Ape in"></o1bot-buy><o1bot-address></o1bot-address><o1bot-socials></o1bot-socials><o1bot-logo size="sm"></o1bot-logo><o1bot-footer></o1bot-footer>`, live, meta);
    expect(out).toContain(`href="${live.buyUrl}"`);
    expect(out).toContain(">Ape in</a>");
    expect(out).toContain(`<code data-address="${live.token}">${live.token}</code>`);
    expect(out).toContain(`href="${live.explorerUrl}"`);
    expect(out).toContain(">X</a>");
    expect(out).toContain(">Website</a>");
    expect(out).not.toContain(">Telegram<");
    expect(out).toContain('width="96"');
    expect(out).toContain("was launched through");
    expect(out).toContain('href="https://o1bot.exchange"');
    expect(out).toContain(">o1bot.exchange</a>");
    expect(out).toContain("Robinhood Chain");
    expect(out).toContain("mailto:hello@o1bot.exchange?subject=Report%20site%20cat.o1bot.app");
  });

  it("shows placeholders while the launch is pending and no report link without an address", () => {
    const pending: LiveData = { ...live, status: "pending", token: null, priceUsd: null, explorerUrl: null };
    const out = renderBlocks("<o1bot-stats></o1bot-stats><o1bot-buy></o1bot-buy><o1bot-address></o1bot-address><o1bot-footer></o1bot-footer>", pending, { ...meta, reportEmail: null });
    expect(out).toContain(">soon<");
    expect(out).toContain("$CAT launches soon");
    expect(out).toContain("published at launch");
    expect(out).not.toContain("Report this site");
  });

  it("escapes what it interpolates", () => {
    const nasty: LiveData = { ...live, symbol: `CAT"><script>`, buyUrl: `https://x/"><script>` };
    const out = renderBlocks("<o1bot-buy></o1bot-buy>", nasty, meta);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("renderSite", () => {
  const files = {
    html: `<main><h1>Cash Cat</h1><o1bot-stats></o1bot-stats><a href="https://cashcat.xyz/">site</a><a href="https://evil.example/">evil</a></main><script>document.title = "Cash Cat";</script>`,
    css: `:root{--o1bot-accent:#ff0}\nh1{color:red}</style><script>x()</script>`,
  };

  it("wraps the sanitized body in a head o1bot controls, policy included", () => {
    const out = renderSite(files, meta, live);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<title>Cash Cat ($CAT)</title>");
    expect(out).toContain('<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39;;');
    expect(out).not.toContain("frame-ancestors"); // not allowed in a meta policy
    expect(out).toContain('<meta property="og:image" content="https://gateway.pinata.cloud/ipfs/logo">');
    expect(out).toContain('<link rel="canonical" href="https://cat.o1bot.app/">');
    expect(out).toContain("$841.6K");
    expect(out).toContain('<script>document.title = "Cash Cat";</script>');
    expect(out).toContain('href="https://cashcat.xyz/"');
    expect(out).toContain("<a>evil</a>");
    // The stylesheet cannot close its element, so the text that follows stays inert CSS.
    expect(out).not.toContain("</style><script>x()");
    expect(out).toContain("<\\/style><script>x()");
    expect(out).toContain(".o1bot-stats{");
  });

  it("marks pending sites noindex", () => {
    const out = renderSite(files, meta, { ...live, status: "pending", token: null });
    expect(out).toContain('<meta name="robots" content="noindex">');
  });
});

describe("siteCsp", () => {
  it("allows inline scripts only, requests to the app only, images from the logo gateways, and no frames or forms", () => {
    const csp = siteCsp({ rootDomain: "o1bot.app", appUrl: "https://o1bot.exchange", imageOrigins: [live.logoUrl, null] });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*https:/);
    expect(csp).toContain("connect-src https://o1bot.exchange");
    expect(csp).toContain("img-src data: https://o1bot.exchange https://gateway.pinata.cloud https://moccasin-wooden-ptarmigan-419.mypinata.cloud");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self' https://o1bot.exchange");
    expect(csp).toContain("style-src 'unsafe-inline' https://fonts.googleapis.com");
  });

  it("leaves frame-ancestors out of the meta form", () => {
    expect(siteCsp({ rootDomain: "o1bot.app", appUrl: "https://o1bot.exchange" }, { meta: true })).not.toContain("frame-ancestors");
  });
});

describe("placeholderPage", () => {
  it("explains the state and links to the app", () => {
    expect(placeholderPage("cat", "o1bot.app", "generating")).toContain("being built");
    expect(placeholderPage("cat", "o1bot.app", "suspended")).toContain("taken down");
    expect(placeholderPage("cat", "o1bot.app", "unknown")).toContain("no site here");
    expect(placeholderPage("cat", "o1bot.app", "unknown")).toContain('href="https://o1bot.exchange"');
    expect(placeholderPage("<b>", "o1bot.app", "unknown")).toContain("&lt;b&gt;");
  });
});
