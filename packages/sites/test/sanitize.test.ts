import { describe, expect, it } from "vitest";
import { sanitizeSiteCss, sanitizeSiteHtml } from "../src/sanitize";

describe("sanitizeSiteHtml", () => {
  it("removes scripts with their content, handlers and javascript: links", () => {
    const out = sanitizeSiteHtml(`<h1 onclick="steal()">Cat</h1><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)">`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).toContain("<h1>Cat</h1>");
    expect(out).toContain("<a>x</a>");
  });

  it("drops frames, forms, objects, styles and meta from the body", () => {
    const out = sanitizeSiteHtml(`<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="pk"><button>go</button></form><object data="x"></object><style>body{display:none}</style><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/a.css"><base href="https://evil.example/">`);
    expect(out).not.toMatch(/iframe|<form|<input|<object|<style|<meta|<link|<base/);
    expect(out).not.toContain("display:none");
  });

  it("keeps layout, text, images over https or data, and a subset of SVG", () => {
    const html = `<section class="hero" style="background:#123"><h2>Moon Frog</h2><p>To the <strong>moon</strong>.</p><img src="https://gateway.pinata.cloud/ipfs/abc" alt="logo" width="160"><img src="data:image/png;base64,AAAA" alt="pixel"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0f0"></circle></svg></section>`;
    const out = sanitizeSiteHtml(html);
    expect(out).toContain('class="hero"');
    expect(out).toContain('style="background:#123"');
    expect(out).toContain('src="https://gateway.pinata.cloud/ipfs/abc"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('<circle cx="5" cy="5" r="4" fill="#0f0"></circle>');
  });

  it("refuses http images and unknown svg attributes", () => {
    const out = sanitizeSiteHtml(`<img src="http://evil.example/a.png"><svg><a xlink:href="javascript:1"></a><use href="https://evil.example/x.svg#a"></use></svg>`);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("xlink");
  });

  it("opens external links in a new tab without a referrer", () => {
    expect(sanitizeSiteHtml(`<a href="https://x.com/o1bot_exchange">X</a>`)).toBe(`<a href="https://x.com/o1bot_exchange" target="_blank" rel="noopener noreferrer">X</a>`);
    expect(sanitizeSiteHtml(`<a href="#about">About</a>`)).toBe(`<a href="#about">About</a>`);
  });

  it("keeps the o1bot blocks, also when written as void tags", () => {
    const out = sanitizeSiteHtml(`<o1bot-stats></o1bot-stats><o1bot-buy label="Ape in"/><p>after</p><o1bot-logo size="lg" />`);
    expect(out).toContain("<o1bot-stats></o1bot-stats>");
    expect(out).toContain('<o1bot-buy label="Ape in"></o1bot-buy>');
    expect(out).toContain("<p>after</p>");
    expect(out).toContain('<o1bot-logo size="lg"></o1bot-logo>');
  });
});

describe("sanitizeSiteCss", () => {
  it("cannot close the style element it is placed in", () => {
    expect(sanitizeSiteCss(`body{color:red}</style><script>alert(1)</script>`)).toBe(`body{color:red}<\\/style><script>alert(1)</script>`);
    expect(sanitizeSiteCss(`a{b:c}</ STYLE >`)).toContain("<\\/style");
  });
});
