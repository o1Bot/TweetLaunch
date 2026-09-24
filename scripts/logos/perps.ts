import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Logos for the perp markets, served by apps/perps itself.
 *
 * The venue publishes no logo field — `orderBookDetails` carries 52 fields and
 * not one of them is an image — so they are collected here and stored as
 * apps/perps/public/logos/<SYMBOL>.png with a manifest at
 * apps/perps/lib/logos.json. Nothing is hotlinked, so a user's network cannot
 * break them, and nothing depends on a third party staying up.
 *
 *   pnpm logos:perps            # adds what is missing, keeps what exists
 *   pnpm logos:perps --refresh  # fetches everything again
 *
 * Plenty of markets have no logo and never will: EURUSD is a pair, XAU is a
 * metal, US500 is an index. Those are left out on purpose — the UI draws a
 * coloured tile with the symbol's first letters, which is honest, rather than a
 * generic icon that implies a brand exists.
 */

const ROOT = process.cwd();
const OUT = path.join(ROOT, "apps", "perps", "public", "logos");
const MANIFEST = path.join(ROOT, "apps", "perps", "lib", "logos.json");
const SHARED = path.join(ROOT, "apps", "web", "public", "logos");
const refresh = process.argv.includes("--refresh");

const API = process.env.NEXT_PUBLIC_LIGHTER_API ?? "https://mainnet.zklighter.elliot.ai";
const CRYPTO = "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color";
const GECKO = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250";
/** Pages of the ranked list to read. 750 coins covers everything the venue lists. */
const GECKO_PAGES = 3;
const stockSource = (s: string): string => `https://assets.parqet.com/logos/symbol/${s}?format=png`;
const proxied = (url: string): string =>
  `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}&output=png`;

/**
 * The venue prefixes a multiplier onto cheap tokens and suffixes the quote onto
 * some RWA names. The logo belongs to the asset, not to the contract size.
 */
function assetOf(symbol: string): string {
  const m = /^1000(.+)$/.exec(symbol);
  if (m?.[1]) return m[1];
  const u = /^(HYUNDAI|SKHYNIX|SAMSUNG)USD$/.exec(symbol);
  if (u?.[1]) return u[1];
  return symbol;
}

/**
 * Markets that must never take a logo from anywhere.
 *
 * A commodity, an index and a currency pair have no brand, so any match is a
 * collision rather than a find — and the sources are happy to serve one. The
 * ticker WTI belongs to W&T Offshore, Inc. on the NYSE, so a stock logo service
 * returns that company's mark for a crude oil market; XAU, US500 and EURUSD
 * would go the same way given the chance. A lettered tile is correct here, and
 * a confident wrong logo is the one outcome worth ruling out.
 */
const NO_BRAND = new Set([
  // metals and energy as price codes. PAXG is deliberately absent: it is a real
  // ERC-20 with its own brand, not a bare commodity ticker.
  "XAU", "XAG", "XPT", "XPD", "XCU", "WTI", "BRENTOIL", "NATGAS", "WHEAT",
  // indices
  "US500", "US100", "US10Y", "SPX",
]);

/** Six letters made of two ISO currency codes: EURUSD, USDJPY, AUDUSD … */
const FX = /^(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|HKD|KRW|CNY|SGD)(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|HKD|KRW|CNY|SGD)$/;

function hasBrand(symbol: string): boolean {
  return !NO_BRAND.has(symbol) && !FX.test(symbol);
}

const isImage = (b: Buffer): boolean =>
  b.length > 64 && ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 4).toString() === "RIFF");

function download(url: string, out: string): boolean {
  try {
    execFileSync("curl", ["-sS", "-L", "--max-time", "30", "-A", "Mozilla/5.0", "-o", out, url], { stdio: "pipe" });
    if (isImage(readFileSync(out))) return true;
  } catch {
    // fall through to cleanup
  }
  try {
    unlinkSync(out);
  } catch {
    // nothing to remove
  }
  return false;
}

/**
 * Symbol → logo, taken from the market-cap-ranked list rather than from a
 * symbol search. Searching by symbol returns whatever matched first, which is
 * how PEPE resolves to "baby-pepe-5", SHIB to "binance-peg-shib" and TRUMP to
 * "bridged-maga-wormhole" — knockoffs that would have shipped as the real
 * thing. Ranking by market cap and keeping the first occurrence picks the
 * asset the market means.
 */
async function geckoLogos(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; page <= GECKO_PAGES; page++) {
    try {
      const res = await fetch(`${GECKO}&page=${page}`);
      const rows = (await res.json()) as Array<{ symbol?: string; image?: string }>;
      if (!Array.isArray(rows)) break;
      for (const r of rows) {
        const s = (r.symbol ?? "").toUpperCase();
        if (s && r.image && !out.has(s)) out.set(s, r.image);
      }
    } catch {
      break; // a missing page costs coverage, not correctness
    }
    await new Promise((r) => setTimeout(r, 2000)); // the public tier rate-limits
  }
  return out;
}

async function activeSymbols(): Promise<string[]> {
  const res = await fetch(`${API}/api/v1/orderBookDetails`);
  const body = (await res.json()) as { order_book_details?: Array<{ symbol: string; status?: string }> };
  const rows = (body.order_book_details ?? []).filter((m) => m.status === "active");
  if (rows.length === 0) throw new Error("the venue returned no active markets");
  return [...new Set(rows.map((m) => m.symbol.toUpperCase()))].sort();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const symbols = await activeSymbols();
  const gecko = await geckoLogos();
  console.log(`${gecko.size} ranked crypto logos available`);

  const have: string[] = [];
  const missing: string[] = [];
  let reused = 0;

  for (const symbol of symbols) {
    const out = path.join(OUT, `${symbol}.png`);

    if (!hasBrand(symbol)) {
      // Remove one fetched before this rule existed, so a re-run corrects it.
      if (existsSync(out)) unlinkSync(out);
      missing.push(symbol);
      continue;
    }

    if (!refresh && existsSync(out)) {
      have.push(symbol);
      continue;
    }

    // The main site already carries most of the stock set; copying beats
    // fetching the same file twice and keeps the two sites showing one logo.
    const asset = assetOf(symbol);
    const shared = path.join(SHARED, `${asset}.png`);
    if (existsSync(shared)) {
      copyFileSync(shared, out);
      have.push(symbol);
      reused += 1;
      continue;
    }

    const ranked = gecko.get(asset);
    const sources = [
      ...(ranked ? [ranked] : []),
      `${CRYPTO}/${asset.toLowerCase()}.png`,
      stockSource(asset),
    ];
    let got = false;
    for (const url of sources) {
      got = download(url, out) || download(proxied(url), out);
      if (got) break;
    }
    if (got) {
      have.push(symbol);
      process.stdout.write(`${symbol} `);
    } else {
      missing.push(symbol);
    }
  }

  const list = [...have].sort();
  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ note: "Perp symbols with a logo in public/logos, kept by scripts/logos/perps.ts.", symbols: list }, null, 2)}\n`,
  );
  console.log(`\n${list.length} of ${symbols.length} markets have a logo (${reused} copied from the main site).`);
  console.log(`no logo, drawn as a lettered tile: ${missing.join(", ")}`);
}

void main();
