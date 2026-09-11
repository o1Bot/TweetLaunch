import { describe, expect, it } from "vitest";
import { cleanSiteSlug, normalizeParseOutput, SITE_TOKEN_QUESTION } from "../src/normalize";
import type { ParseOutput } from "../src/schema";

const base: ParseOutput = {
  kind: "site",
  language: "en",
  topic: "none",
  ticker: "CAT",
  name: null,
  pair: null,
  chain: null,
  devbuy_native: null,
  fees_to_handle: null,
  description: null,
  website: null,
  telegram: null,
  x_handle: null,
  site_slug: "auto",
  trade_side: null,
  trade_amount: null,
  trade_slippage_pct: null,
  missing: [],
  question: null,
  reply: null,
  reason: "test",
};
const norm = (over: Partial<ParseOutput>) => normalizeParseOutput({ ...base, ...over }, { hasImage: false });

describe("cleanSiteSlug", () => {
  it("distinguishes no site, the default name and a chosen name", () => {
    expect(cleanSiteSlug("")).toBeNull();
    expect(cleanSiteSlug(null)).toBeNull();
    expect(cleanSiteSlug("auto")).toBe("auto");
    expect(cleanSiteSlug("AUTO")).toBe("auto");
    expect(cleanSiteSlug(" catcoin ")).toBe("catcoin");
    expect(cleanSiteSlug("$catcoin")).toBe("catcoin");
  });

  it("never takes a URL or a domain as a subdomain name", () => {
    expect(cleanSiteSlug("https://cat.xyz")).toBeNull();
    expect(cleanSiteSlug("cat.xyz")).toBeNull();
    expect(cleanSiteSlug("cat.xyz/home")).toBeNull();
  });
});

describe("normalizeParseOutput for site commands", () => {
  it("builds a site command for a ticker or an address", () => {
    expect(norm({})).toEqual({ kind: "site", ticker: "CAT", tokenAddress: null, slug: null, language: "en", reason: "test" });
    expect(norm({ site_slug: "catcoin" })).toMatchObject({ kind: "site", slug: "catcoin" });
    const addr = "0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01";
    expect(norm({ ticker: addr })).toMatchObject({ kind: "site", ticker: null, tokenAddress: addr });
  });

  it("asks which token when none is named", () => {
    expect(norm({ ticker: null })).toEqual({ kind: "clarify", question: SITE_TOKEN_QUESTION, missing: ["trade_token"], language: "en", reason: "test" });
    expect(norm({ ticker: "not a ticker" })).toMatchObject({ kind: "clarify" });
  });

  it("carries the site wish on a launch", () => {
    const launch = { kind: "launch" as const, ticker: "CAT", name: "Cash Cat", pair: "ETH" };
    expect(norm({ ...launch, site_slug: "" })).toMatchObject({ kind: "launch", siteSlug: null });
    expect(norm({ ...launch, site_slug: "auto" })).toMatchObject({ kind: "launch", siteSlug: "auto" });
    expect(norm({ ...launch, site_slug: "catcoin" })).toMatchObject({ kind: "launch", siteSlug: "catcoin" });
    expect(norm({ ...launch, site_slug: "https://cat.xyz", website: "https://cat.xyz" })).toMatchObject({ kind: "launch", siteSlug: null, website: "https://cat.xyz" });
  });
});
