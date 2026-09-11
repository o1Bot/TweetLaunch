import { describe, expect, it } from "vitest";
import { placeholderPage, renderBlocks, renderSite, siteCsp } from "../src/render";
import type { LiveData, SiteMeta } from "../src/types";

const meta: SiteMeta = { slug: "cat", rootDomain: "o1bot.exchange", title: "Cash Cat ($CAT)", description: "The cat that pays.", lang: "en", ogImage: "https://gateway.pinata.cloud/ipfs/logo" };

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
  logoUrl: "https://gateway.pinata.cloud/ipfs/logo",
  pageUrl: "https://o1bot.exchange/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  buyUrl: "https://o1bot.exchange/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01#swap",
  explorerUrl: "https://rh-scan.com/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  socials: { x: "https://x.com/cashcat", telegram: null, website: null },
  launchedAt: "2026-09-08T10:00:00.000Z",
};

describe("renderBlocks", () => {
  it("fills the stats block with formatted live numbers", () => {
    const out = renderBlocks("<o1bot-stats></o1bot-stats>", live, meta);
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
    expect(out).toContain(`<code>${live.token}</code>`);
    expect(out).toContain(`href="${live.explorerUrl}"`);
    expect(out).toContain(">X</a>");
    expect(out).not.toContain(">Telegram<");
    expect(out).toContain('width="96"');
    expect(out).toContain("was launched through");
    expect(out).toContain("Robinhood Chain");
  });

  it("shows placeholders while the launch is pending", () => {
    const pending: LiveData = { ...live, status: "pending", token: null, priceUsd: null, explorerUrl: null };
    const out = renderBlocks("<o1bot-stats></o1bot-stats><o1bot-buy></o1bot-buy><o1bot-address></o1bot-address>", pending, meta);
    expect(out).toContain(">soon<");
    expect(out).toContain("$CAT launches soon");
    expect(out).toContain("published at launch");
  });

  it("escapes what it interpolates", () => {
    const nasty: LiveData = { ...live, symbol: `CAT"><script>`, buyUrl: `https://x/"><script>` };
    const out = renderBlocks("<o1bot-buy></o1bot-buy>", nasty, meta);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("renderSite", () => {
  const files = { html: `<main><h1>Cash Cat</h1><o1bot-stats></o1bot-stats><script>alert(1)</script></main>`, css: `:root{--o1bot-accent:#ff0}\nh1{color:red}</style><script>x()</script>` };

  it("wraps the sanitized body in a head o1bot controls", () => {
    const out = renderSite(files, meta, live);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<title>Cash Cat ($CAT)</title>");
    expect(out).toContain('<meta property="og:image" content="https://gateway.pinata.cloud/ipfs/logo">');
    expect(out).toContain('<link rel="canonical" href="https://cat.o1bot.exchange/">');
    expect(out).toContain("$841.6K");
    expect(out).not.toContain("alert(1)");
    // The stylesheet cannot close its element, so the text that follows stays inert CSS.
    expect(out).not.toContain("</style><script>");
    expect(out).toContain("<\\/style><script>x()");
    expect(out).toContain(".o1bot-stats{");
  });

  it("marks pending sites noindex", () => {
    const out = renderSite(files, meta, { ...live, status: "pending", token: null });
    expect(out).toContain('<meta name="robots" content="noindex">');
  });
});

describe("siteCsp", () => {
  it("allows no scripts, no frames and no forms", () => {
    const csp = siteCsp("o1bot.exchange");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'self' https://o1bot.exchange https://www.o1bot.exchange");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });
});

describe("placeholderPage", () => {
  it("explains the state and links home", () => {
    expect(placeholderPage("cat", "o1bot.exchange", "generating")).toContain("being built");
    expect(placeholderPage("cat", "o1bot.exchange", "unknown")).toContain("no site here");
    expect(placeholderPage("<b>", "o1bot.exchange", "unknown")).toContain("&lt;b&gt;");
  });
});
