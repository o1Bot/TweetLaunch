import { describe, expect, it } from "vitest";
import { ART_DIRECTIONS, briefText, directionFor, type SiteBrief } from "../src/brief";
import { applyEdits, HTML_MAX_BYTES, postProcess, SiteGenerationError, systemPrompt, userMessage, wantsRewrite, type GeneratedSite } from "../src/generate";
import { BLOCK_TAGS } from "../src/sanitize";

const brief: SiteBrief = {
  slug: "cat",
  rootDomain: "o1bot.app",
  apiOrigin: "https://o1bot.exchange",
  name: "Cash Cat",
  symbol: "CAT",
  chain: "robinhood",
  pairSymbol: "ETH",
  tokenAddress: "0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  description: "The cat that pays its own rent.",
  originPost: 'launch $CAT "Cash Cat" pair ETH site',
  creatorHandle: "alice",
  logoUrl: "https://gateway.pinata.cloud/ipfs/logo",
  palette: ["#f4c430", "#111111"],
  socials: { x: "https://x.com/cashcat", telegram: null, website: null },
  language: "en",
  direction: "Bold editorial: a huge serif display headline.",
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
    expect(text).toContain("https://cat.o1bot.app");
    expect(text).toContain('"The cat that pays its own rent."');
    expect(text).toContain("#f4c430, #111111");
    expect(text).toContain("Telegram none");
    expect(text).toContain("half of it goes to the creator");
    expect(text).toContain("Contract address: 0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
    expect(text).toContain("GET https://o1bot.exchange/api/token/0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01/candles?tf=15m");
    const bare = briefText({ ...brief, logoUrl: null, palette: null, originPost: null, tokenAddress: null });
    expect(bare).toContain("none; use typography");
    expect(bare).toContain("launched from the web form");
    expect(bare).not.toContain("/api/token/");
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

describe("art directions", () => {
  it("assigns a stable direction per token and moves on with the salt", () => {
    const a = directionFor("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
    expect(ART_DIRECTIONS).toContain(a);
    expect(directionFor("0x0AB6BF0FFA6D5C5AAA8FC94A8FB2F4EA2F4F5C01")).toBe(a);
    expect(directionFor("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01", 1)).not.toBe(a);
    const seen = new Set(ART_DIRECTIONS.map((_, i) => directionFor("cat", i)));
    expect(seen.size).toBe(ART_DIRECTIONS.length);
  });

  it("puts the direction in the brief", () => {
    expect(briefText(brief)).toContain("Art direction for this build");
    expect(briefText(brief)).toContain("Bold editorial");
  });
});

describe("wantsRewrite", () => {
  it("recognises a request for a different site, not a change to this one", () => {
    for (const s of ["Start over with a completely different visual idea", "redesign it", "please rebuild the whole thing", "give it a new look", "something completely different", "from scratch please"]) expect(wantsRewrite(s)).toBe(true);
    for (const s of ["make the hero red", "shorter copy", "the logo is too big, fix it", null, ""]) expect(wantsRewrite(s)).toBe(false);
  });
});

describe("applyEdits", () => {
  const files = { html: `<h1 class="hero__name">Cash Cat</h1><p>To the moon.</p>`, css: `.hero{color:red}\n.hero__name{font-size:3rem}` };

  it("applies unique edits in order, including deletions, across both files", () => {
    const out = applyEdits(files, [
      { file: "index.html", find: "Cash Cat", replace: "Cash Cat!" },
      { file: "index.html", find: "<p>To the moon.</p>", replace: "" },
      { file: "styles.css", find: "font-size:3rem", replace: "font-size:5rem" },
    ]);
    expect(out).toEqual({ ok: true, files: { html: `<h1 class="hero__name">Cash Cat!</h1>`, css: `.hero{color:red}\n.hero__name{font-size:5rem}` } });
  });

  it("refuses an edit whose find is empty, missing or not unique", () => {
    expect(applyEdits(files, [{ file: "index.html", find: "", replace: "x" }])).toMatchObject({ ok: false, reason: "edit 1: empty find" });
    expect(applyEdits(files, [{ file: "styles.css", find: "nope", replace: "x" }])).toMatchObject({ ok: false, reason: "edit 1 (styles.css): find matches 0 times" });
    expect(applyEdits(files, [{ file: "styles.css", find: ".hero", replace: ".x" }])).toMatchObject({ ok: false, reason: "edit 1 (styles.css): find matches 2 times" });
  });

  it("treats replacement text literally", () => {
    expect(applyEdits(files, [{ file: "index.html", find: "moon", replace: "$& $1 moon" }])).toMatchObject({ ok: true, files: { html: `<h1 class="hero__name">Cash Cat</h1><p>To the $& $1 moon.</p>` } });
  });
});

describe("systemPrompt", () => {
  it("names every block, allows one inline script and forbids inputs, redirects and wallet prompts", () => {
    const p = systemPrompt();
    for (const tag of BLOCK_TAGS) expect(p).toContain(`<${tag}`);
    expect(p).toContain("one inline <script>");
    expect(p).toContain("No <iframe>, <form>, <input>");
    expect(p).toContain("may not: navigate or redirect");
    expect(p).toContain("wallet connection");
    expect(p).not.toMatch(/—/);
  });
});
