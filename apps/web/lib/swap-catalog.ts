import { erc20Abi, formatUnits, getAddress, isAddress, zeroAddress, type Address } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { cryptoQuotes, env, publicClient, stockQuotes } from "@o1bot/shared";
import { NATIVE_SYMBOL, type ChainKey } from "./chains-web";
import { ipfsToHttp } from "./ipfs";
import type { QuoteKind } from "./types";

/**
 * Every token the swap page can offer on a chain: the gas asset, the stable
 * and stock quotes o1 registers, every token launched through o1bot, and any
 * ERC-20 the user pastes. With a wallet, each entry carries its balance.
 */

export type CatalogToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: "native" | "crypto" | "stock" | "o1" | "custom";
  imageUrl: string | null;
  balance: string | null;
  /** For o1 launches: the pool asset the token trades against, which is the only pair the o1 route offers. */
  o1: { quoteAddress: Address; quoteSymbol: string; quoteKind: QuoteKind; launchedAt: string } | null;
};

const CATALOG_TTL_MS = 60_000;
const cache = new Map<ChainKey, { at: number; tokens: CatalogToken[] }>();

export function quoteKindOf(address: string, symbol: string): QuoteKind {
  if (getAddress(address.toLowerCase()) === zeroAddress) return "eth";
  const s = symbol.toUpperCase();
  return s === "USDG" || s === "USDC" ? "usd" : "stk";
}

/** The catalog without balances, cached for a minute. */
export async function swapCatalog(chain: ChainKey): Promise<CatalogToken[]> {
  const cached = cache.get(chain);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.tokens;
  const tokens: CatalogToken[] = [];
  // Arc's gas asset is USDC, which LI.FI knows only as the ERC-20 at 0x3600…; it is in the crypto quotes below.
  if (chain !== "arc") tokens.push({ address: zeroAddress, symbol: NATIVE_SYMBOL[chain], name: chain === "robinhood" ? "Ether on Robinhood Chain" : "Ether", decimals: 18, kind: "native", imageUrl: null, balance: null, o1: null });
  for (const q of cryptoQuotes(chain)) {
    if (getAddress(q.address.toLowerCase()) === zeroAddress) continue;
    tokens.push({ address: getAddress(q.address.toLowerCase()), symbol: q.symbol, name: q.name ?? q.symbol, decimals: q.decimals, kind: "crypto", imageUrl: null, balance: null, o1: null });
  }
  for (const q of stockQuotes(chain)) {
    tokens.push({ address: getAddress(q.address.toLowerCase()), symbol: q.symbol, name: q.name ?? q.symbol, decimals: q.decimals, kind: "stock", imageUrl: null, balance: null, o1: null });
  }
  if (dbConfigured()) {
    const showDev = Boolean(env().SHOW_DEV_TOKENS);
    const chainId = chain === "robinhood" ? 4663 : chain === "base" ? 8453 : 5042;
    const pools = await db().pool.findMany({
      where: { chainId, ...(showDev ? {} : { source: { not: "DEV" } }) },
      select: { token: true, symbol: true, name: true, imageUri: true, quoteAddress: true, quoteSymbol: true, launchedAt: true },
      orderBy: { launchedAt: "desc" },
    });
    for (const p of pools) {
      tokens.push({
        address: getAddress(p.token),
        symbol: p.symbol,
        name: p.name,
        decimals: 18,
        kind: "o1",
        imageUrl: p.imageUri ? ipfsToHttp(p.imageUri) : null,
        balance: null,
        o1: { quoteAddress: getAddress(p.quoteAddress.toLowerCase()), quoteSymbol: p.quoteSymbol, quoteKind: quoteKindOf(p.quoteAddress, p.quoteSymbol), launchedAt: p.launchedAt.toISOString() },
      });
    }
  }
  cache.set(chain, { at: Date.now(), tokens });
  return tokens;
}

export async function findCatalogToken(chain: ChainKey, address: string): Promise<CatalogToken | null> {
  if (!isAddress(address, { strict: false })) return null;
  const want = getAddress(address.toLowerCase());
  return (await swapCatalog(chain)).find((t) => t.address === want) ?? null;
}

/** An ERC-20 the catalog does not list, read from the chain. Null when the address is not a token. */
export async function resolveCustomToken(chain: ChainKey, address: string): Promise<CatalogToken | null> {
  if (!isAddress(address, { strict: false })) return null;
  const token = getAddress(address.toLowerCase());
  const listed = await findCatalogToken(chain, token);
  if (listed) return listed;
  const client = publicClient(chain);
  const code = await client.getCode({ address: token }).catch(() => undefined);
  if (!code || code === "0x") return null;
  const [symbol, name, decimals] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "name" },
      { address: token, abi: erc20Abi, functionName: "decimals" },
    ],
  });
  if (decimals.status !== "success" || symbol.status !== "success") return null;
  return { address: token, symbol: String(symbol.result), name: name.status === "success" ? String(name.result) : String(symbol.result), decimals: Number(decimals.result), kind: "custom", imageUrl: null, balance: null, o1: null };
}

/** The same tokens with the wallet's balances, in human units. */
export async function withBalances(chain: ChainKey, tokens: CatalogToken[], wallet: Address): Promise<CatalogToken[]> {
  const client = publicClient(chain);
  const erc20s = tokens.filter((t) => t.address !== zeroAddress);
  const [native, balances] = await Promise.all([
    client.getBalance({ address: wallet }).catch(() => null),
    erc20s.length ? client.multicall({ allowFailure: true, contracts: erc20s.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }) as const) }) : Promise.resolve([]),
  ]);
  const byAddress = new Map<Address, string | null>();
  erc20s.forEach((t, i) => {
    const r = balances[i];
    byAddress.set(t.address, r && r.status === "success" ? formatUnits(r.result as bigint, t.decimals) : null);
  });
  return tokens.map((t) => ({ ...t, balance: t.address === zeroAddress ? (native === null ? null : formatUnits(native, 18)) : (byAddress.get(t.address) ?? null) }));
}
