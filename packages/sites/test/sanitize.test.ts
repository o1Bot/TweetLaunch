import { describe, expect, it } from "vitest";
import { linkHostAllowed, sanitizeSiteCss, sanitizeSiteHtml } from "../src/sanitize";

describe("sanitizeSiteHtml", () => {
  it("keeps inline scripts and styles but strips script sources, handlers and javascript: links", () => {
    const out = sanitizeSiteHtml(`<h1 onclick="steal()">Cat</h1><script>console.log(1)</script><script src="https://evil.example/x.js"></script><style>h1{color:red}</style><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)">`);
    expect(out).toContain("<script>console.log(1)</script>");
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/<script [^>]*src=/);
    expect(out).toContain("<style>h1{color:red}</style>");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).toContain("<h1>Cat</h1>");
    expect(out).toContain("<a>x</a>");
  });

  it("drops frames, forms and every kind of input, objects, meta and link elements", () => {
    const out = sanitizeSiteHtml(
      `<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="pk"><textarea>seed</textarea><select><option>a</option></select></form><button type="button">go</button><object data="x"></object><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/a.css"><base href="https://evil.example/">`,
    );
    expect(out).not.toMatch(/iframe|<form|<input|<textarea|<select|<option|<object|<meta|<link|<base/);
    expect(out).not.toContain("seed");
    // Buttons are fine on their own (scripts may use them); a whole form goes, contents included.
    expect(out).toContain('<button type="button">go</button>');
  });

  it("keeps layout, text, canvas, images over https or data, and a subset of SVG", () => {
    const html = `<section class="hero" style="background:#123"><h2>Moon Frog</h2><p>To the <strong>moon</strong>.</p><canvas width="300" height="120"></canvas><img src="https://gateway.pinata.cloud/ipfs/abc" alt="logo" width="160"><img src="data:image/png;base64,AAAA" alt="pixel"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0f0"></circle></svg></section>`;
    const out = sanitizeSiteHtml(html);
    expect(out).toContain('class="hero"');
    expect(out).toContain('style="background:#123"');
    expect(out).toContain('<canvas width="300" height="120"></canvas>');
    expect(out).toContain('src="https://gateway.pinata.cloud/ipfs/abc"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('<circle cx="5" cy="5" r="4" fill="#0f0"></circle>');
  });

  it("refuses http images and unknown svg attributes", () => {
    const out = sanitizeSiteHtml(`<img src="http://evil.example/a.png"><svg><a xlink:href="javascript:1"></a><use href="https://evil.example/x.svg#a"></use></svg>`);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("xlink");
  });

  it("keeps links to allowed hosts, opened in a new tab, and strips the href of every other link", () => {
    expect(sanitizeSiteHtml(`<a href="https://x.com/o1bot_exchange">X</a>`)).toBe(`<a href="https://x.com/o1bot_exchange" target="_blank" rel="noopener noreferrer">X</a>`);
    expect(sanitizeSiteHtml(`<a href="https://cat.o1bot.app/">home</a>`)).toContain('href="https://cat.o1bot.app/"');
    expect(sanitizeSiteHtml(`<a href="#about">About</a>`)).toBe(`<a href="#about">About</a>`);
    expect(sanitizeSiteHtml(`<a href="https://claim-airdrop.example/free">Claim</a>`)).toBe(`<a>Claim</a>`);
    expect(sanitizeSiteHtml(`<a href="mailto:scam@example.com">Mail</a>`)).toBe(`<a>Mail</a>`);
    expect(sanitizeSiteHtml(`<a href="https://cashcat.xyz/">Site</a>`, { allowedLinkHosts: ["cashcat.xyz"] })).toContain('href="https://cashcat.xyz/"');
    expect(sanitizeSiteHtml(`<a href="https://www.cashcat.xyz/">Site</a>`, { allowedLinkHosts: ["cashcat.xyz"] })).toContain('href="https://www.cashcat.xyz/"');
  });

  it("keeps the o1bot blocks, also when written as void tags", () => {
    const out = sanitizeSiteHtml(`<o1bot-stats></o1bot-stats><o1bot-buy label="Ape in"/><p>after</p><o1bot-logo size="lg" />`);
    expect(out).toContain("<o1bot-stats></o1bot-stats>");
    expect(out).toContain('<o1bot-buy label="Ape in"></o1bot-buy>');
    expect(out).toContain("<p>after</p>");
    expect(out).toContain('<o1bot-logo size="lg"></o1bot-logo>');
  });
});

describe("linkHostAllowed", () => {
  it("allows anchors, relative paths, the defaults and their subdomains", () => {
    expect(linkHostAllowed("#top")).toBe(true);
    expect(linkHostAllowed("/token/0xabc")).toBe(true);
    expect(linkHostAllowed("https://t.me/cashcat")).toBe(true);
    expect(linkHostAllowed("https://launch.o1.exchange/token/0xabc")).toBe(true);
    expect(linkHostAllowed("https://evil-x.com/")).toBe(false);
    expect(linkHostAllowed("https://x.com.evil.example/")).toBe(false);
    expect(linkHostAllowed("ftp://x.com/")).toBe(false);
    expect(linkHostAllowed("not a url")).toBe(false);
  });
});

describe("sanitizeSiteCss", () => {
  it("cannot close the style element it is placed in", () => {
    expect(sanitizeSiteCss(`body{color:red}</style><script>alert(1)</script>`)).toBe(`body{color:red}<\\/style><script>alert(1)</script>`);
    expect(sanitizeSiteCss(`a{b:c}</ STYLE >`)).toContain("<\\/style");
  });
});
