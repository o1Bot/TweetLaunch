import { describe, expect, it } from "vitest";
import { briefText, type SiteBrief } from "../src/brief";
import { HTML_MAX_BYTES, postProcess, SiteGenerationError, systemPrompt, userMessage, type GeneratedSite } from "../src/generate";
import { BLOCK_TAGS } from "../src/sanitize";

const brief: SiteBrief = {
  slug: "cat",
  rootDomain: "o1bot.exchange",
  name: "Cash Cat",
  symbol: "CAT",
  chain: "robinhood",
  pairSymbol: "ETH",
  description: "The cat that pays its own rent.",
  originPost: 'launch $CAT "Cash Cat" pair ETH site',
  creatorHandle: "alice",
  logoUrl: "https://gateway.pinata.cloud/ipfs/logo",
  palette: ["#f4c430", "#111111"],
  socials: { x: "https://x.com/cashcat", telegram: null, website: null },
  language: "en",
};

const generated = (over: Partial<GeneratedSite> = {}): GeneratedSite => ({
  summary: "Built the site.",
  title: "Cash Cat ($CAT)",
  description: "The cat that pays its own rent.",
  html: `<header><o1bot-logo></o1bot-logo><h1>Cash Cat</h1><o1bot-stats></o1bot-stats><o1bot-buy label="Get some"></o1bot-buy></header><section id="community"><o1bot-socials></o1bot-socials><o1bot-address></o1bot-address></section><footer><o1bot-footer></o1bot-footer></footer>`,
  css: ":root{--o1bot-accent:#f4c430}",
  ...over,
});

describe("briefText", () => {
  it("states every fact the agent may use and marks what is unknown", () => {
    const text = briefText(brief);
    expect(text).toContain("Ticker: $CAT");
    expect(text).toContain("Chain: Robinhood Chain");
    expect(text).toContain("https://cat.o1bot.exchange");
    expect(text).toContain('"The cat that pays its own rent."');
    expect(text).toContain("#f4c430, #111111");
    expect(text).toContain("Telegram none");
    expect(text).toContain("half of it goes to the creator");
    expect(briefText({ ...brief, logoUrl: null, palette: null, originPost: null })).toContain("none; use typography");
    expect(briefText({ ...brief, logoUrl: null, palette: null, originPost: null })).toContain("launched from the web form");
  });
});

describe("userMessage", () => {
  it("carries the brief and a build instruction the first time", () => {
    const m = userMessage({ brief });
    expect(m).toContain("<brief>");
    expect(m).toContain("Build the site.");
    expect(m).not.toContain("<current_files>");
  });

  it("carries the current files and the creator's instruction on a revision", () => {
    const m = userMessage({ brief, current: { html: "<h1>Hi</h1>", css: "h1{}" }, instruction: "Make the hero red" });
    expect(m).toContain("===FILE: index.html===\n<h1>Hi</h1>");
    expect(m).toContain("===FILE: styles.css===\nh1{}");
    expect(m).toContain("<instruction>\nMake the hero red\n</instruction>");
  });
});

describe("postProcess", () => {
  it("keeps a complete site as it is", () => {
    const out = postProcess(generated());
    expect(out.html).toBe(generated().html);
    for (const tag of BLOCK_TAGS) expect(out.html.match(new RegExp(`<${tag}`, "g"))).toHaveLength(1);
  });

  it("appends missing blocks and keeps the footer last", () => {
    const out = postProcess(generated({ html: `<footer><o1bot-footer></o1bot-footer></footer><h1>Cash Cat</h1>` }));
    expect(out.html).toContain("<o1bot-stats></o1bot-stats>");
    expect(out.html).toContain("<o1bot-buy></o1bot-buy>");
    expect(out.html).toContain("<o1bot-address></o1bot-address>");
    expect(out.html).toContain("<o1bot-socials></o1bot-socials>");
    expect(out.html.trimEnd().endsWith("</footer>")).toBe(true);
    expect(out.html.match(/<o1bot-footer/g)).toHaveLength(1);
    // The logo block is optional: a site without one is fine.
    expect(out.html).not.toContain("<o1bot-logo");
  });

  it("drops duplicate blocks and normalizes void tags", () => {
    const out = postProcess(generated({ html: `<o1bot-stats/><o1bot-stats></o1bot-stats><o1bot-buy/><o1bot-address/><o1bot-socials/><o1bot-footer/>` }));
    expect(out.html.match(/<o1bot-stats/g)).toHaveLength(1);
    expect(out.html.match(/<o1bot-footer/g)).toHaveLength(1);
  });

  it("caps the title and description and refuses oversized files", () => {
    const out = postProcess(generated({ title: "x".repeat(100), description: "y  y\n".repeat(60) }));
    expect(out.title).toHaveLength(70);
    expect(out.description.length).toBeLessThanOrEqual(160);
    expect(out.description).not.toContain("\n");
    expect(() => postProcess(generated({ html: "a".repeat(HTML_MAX_BYTES + 1) }))).toThrow(SiteGenerationError);
  });
});

describe("systemPrompt", () => {
  it("names every block and forbids scripts", () => {
    const p = systemPrompt();
    for (const tag of BLOCK_TAGS) expect(p).toContain(`<${tag}`);
    expect(p).toContain("No JavaScript");
    expect(p).not.toMatch(/—/);
  });
});
