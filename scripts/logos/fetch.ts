import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Fetch the logos the site shows for assets that are not o1 launches: every
 * stock in o1's quote catalogs (config/o1-stocks.*.json), the gas asset and
 * the stables. They are stored in apps/web/public/logos/<SYMBOL>.png and
 * listed in apps/web/lib/logos.json, so the site serves them itself: no
 * third-party hotlinks, no CDN a user's network might block.
 *
 *   pnpm logos:fetch            # adds what is missing, keeps what exists
 *   pnpm logos:fetch --refresh  # fetches everything again
 *
 * Stocks come from Parqet's public logo service by ticker; the Robinhood CDN
 * addresses in aggregator token lists answer one placeholder for every stock.
 * ETH and USDC come from Trust Wallet's assets repository, USDG from the same
 * place aggregators use; WETH shares the ETH logo (lib/logos.ts). ETFs carry
 * their issuer's logo, as brokers show them. Downloads go through curl with a
 * browser agent, and through an image proxy when a host is unreachable from
 * this network.
 */

const ROOT = process.cwd();
const OUT = path.join(ROOT, "apps", "web", "public", "logos");
const MANIFEST = path.join(ROOT, "apps", "web", "lib", "logos.json");
const refresh = process.argv.includes("--refresh");

const TRUST = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets";
const FIXED: Record<string, string[]> = {
  ETH: [`${TRUST}/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png`],
  USDC: [`${TRUST}/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png`],
  USDG: ["https://s2.coinmarketcap.com/static/img/coins/128x128/33793.png", `${TRUST}/0xe343167631d89B6Ffc58B88d6b7fb0228795491D/logo.png`],
};
const stockSources = (symbol: string): string[] => [`https://assets.parqet.com/logos/symbol/${symbol}?format=png`];
const proxied = (url: string): string => `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}&output=png`;

const isImage = (b: Buffer): boolean => b.length > 64 && ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 4).toString() === "RIFF");

function download(url: string, out: string): Buffer | null {
  try {
    execFileSync("curl", ["-sS", "-L", "--max-time", "45", "-A", "Mozilla/5.0", "-o", out, url], { stdio: "pipe" });
    const b = readFileSync(out);
    if (isImage(b)) return b;
  } catch {
    // fall through
  }
  try {
    unlinkSync(out);
  } catch {
    // nothing to remove
  }
  return null;
}

function stockSymbols(): string[] {
  const out = new Set<string>();
  for (const file of readdirSync(path.join(ROOT, "config")).filter((f) => /^o1-stocks\..*\.json$/.test(f))) {
    const json = JSON.parse(readFileSync(path.join(ROOT, "config", file), "utf8")) as { quotes?: Array<{ symbol: string }> };
    for (const q of json.quotes ?? []) out.add(q.symbol.toUpperCase());
  }
  return [...out].sort();
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const symbols = [...Object.keys(FIXED), ...stockSymbols()];
  const have = new Set<string>();
  const missing: string[] = [];
  for (const symbol of symbols) {
    const out = path.join(OUT, `${symbol}.png`);
    if (!refresh && existsSync(out)) {
      have.add(symbol);
      continue;
    }
    const sources = FIXED[symbol] ?? stockSources(symbol);
    let got: Buffer | null = null;
    for (const url of sources) {
      got = download(url, out) ?? download(proxied(url), out);
      if (got) break;
    }
    if (!got) {
      missing.push(symbol);
      continue;
    }
    have.add(symbol);
    process.stdout.write(`${symbol} `);
  }
  const list = [...have].sort();
  writeFileSync(MANIFEST, `${JSON.stringify({ note: "Symbols with a logo in public/logos, kept by scripts/logos/fetch.ts.", symbols: list }, null, 2)}\n`);
  console.log(`\n${list.length} logos in apps/web/public/logos, manifest at apps/web/lib/logos.json`);
  if (missing.length) console.log(`no logo for: ${missing.join(", ")}`);
}

main();
