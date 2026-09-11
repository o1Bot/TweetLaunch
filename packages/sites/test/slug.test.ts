import { describe, expect, it } from "vitest";
import { checkSlug, normalizeSlug, siteUrl, slugFromHost, slugFromTicker } from "../src/slug";

describe("slugs", () => {
  it("normalizes tickers and free text into DNS labels", () => {
    expect(normalizeSlug("$CAT")).toBe("cat");
    expect(normalizeSlug("  Cash Cat ")).toBe("cash-cat");
    expect(normalizeSlug("cat_coin!!")).toBe("cat-coin");
    expect(normalizeSlug("--a--b--")).toBe("a-b");
    expect(normalizeSlug("héllo wörld")).toBe("hllo-wrld");
  });

  it("accepts labels of 3 to 32 characters without edge hyphens", () => {
    expect(checkSlug("cat")).toEqual({ ok: true, slug: "cat" });
    expect(checkSlug("moon-frog-2026")).toEqual({ ok: true, slug: "moon-frog-2026" });
    expect(checkSlug("ab")).toMatchObject({ ok: false, reason: "invalid" });
    expect(checkSlug("a".repeat(33))).toMatchObject({ ok: false, reason: "invalid" });
    expect(checkSlug("a".repeat(32))).toMatchObject({ ok: true });
    expect(checkSlug("-cat")).toMatchObject({ ok: true, slug: "cat" });
  });

  it("refuses labels the app or the infrastructure could need", () => {
    for (const s of ["www", "api", "token", "o1bot", "mail", "vercel", "swap"]) expect(checkSlug(s)).toMatchObject({ ok: false, reason: "reserved" });
  });

  it("pads short or reserved tickers so every token can get a site", () => {
    expect(slugFromTicker("O1")).toEqual({ ok: true, slug: "o1-token" });
    expect(slugFromTicker("X")).toEqual({ ok: true, slug: "x-token" });
    expect(slugFromTicker("CAT")).toEqual({ ok: true, slug: "cat" });
  });

  it("builds and reads site hosts", () => {
    expect(siteUrl("cat", "o1bot.exchange")).toBe("https://cat.o1bot.exchange");
    expect(slugFromHost("cat.o1bot.exchange", "o1bot.exchange")).toBe("cat");
    expect(slugFromHost("CAT.o1bot.exchange:443", "o1bot.exchange")).toBe("cat");
    expect(slugFromHost("o1bot.exchange", "o1bot.exchange")).toBeNull();
    expect(slugFromHost("www.o1bot.exchange", "o1bot.exchange")).toBeNull();
    expect(slugFromHost("a.b.o1bot.exchange", "o1bot.exchange")).toBeNull();
    expect(slugFromHost("cat.localhost:3000", "localhost")).toBe("cat");
    expect(slugFromHost("evil.example.com", "o1bot.exchange")).toBeNull();
  });
});
