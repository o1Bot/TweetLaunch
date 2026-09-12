import { erc20Abi, formatUnits, getAddress, zeroAddress, type Address } from "viem";
import { db, type Prisma } from "@o1bot/db";
import { feeEscrowAbi, quoteUsd } from "@o1bot/executor";
import { computeStats } from "@o1bot/market";
import { activeFeeEscrow, chainByKey, chainKeyById, env, findQuote, INDEXED_CHAIN_KEYS, logger, parseFeeSplitConfig, publicClient, recipientShareOf, type ChainKey } from "@o1bot/shared";
import { COUNTED_TRADE_STATUSES } from "./store";

/**
 * What the bot can look up to answer a question from a post: its own
 * statistics, one token's market data, and the poster's wallet, launches,
 * fees and trades. Everything comes from the tables the indexer and the
 * pipeline fill, plus balance and escrow reads on chain; nothing here is
 * ever signed. Behind an interface so tests and DB-less dry runs use the
 * in-memory version.
 */

export type ChainScope = ChainKey | null;

export type PlatformStats = {
  launches: { total: number; robinhood: number; base: number };
  trades: number;
  volume24hUsd: number | null;
  volumeAllUsd: number | null;
  latest: { symbol: string; chain: ChainKey; launchedAt: Date } | null;
};

export type TokenSummary = {
  token: string;
  symbol: string;
  name: string;
  chain: ChainKey;
  quoteSymbol: string;
  priceQuote: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  volumeAllUsd: number | null;
  mcapUsd: number | null;
  trades: number;
  /** From o1's Public API; null when unavailable. */
  holders: number | null;
  launchedAt: Date;
  creatorHandle: string | null;
  /** The creator's half of the hook fees so far, in the quote asset (human units). */
  creatorFeesQuote: number;
};

export type BalanceRow = { symbol: string; balance: string; usd: number | null };
export type WalletSummary = {
  address: string;
  /** Native balance per chain the bot works on. */
  eth: Array<{ chain: ChainKey; eth: string; usd: number | null }>;
  /** Stable and paired assets the wallet holds. */
  quotes: Array<BalanceRow & { chain: ChainKey }>;
  /** o1bot tokens the wallet holds, largest first (at most `TOKENS_SHOWN`). */
  tokens: Array<BalanceRow & { chain: ChainKey }>;
  tokensCount: number;
  /** Creator fees waiting in o1's escrow. */
  feesOwed: Array<BalanceRow & { chain: ChainKey }>;
  totalUsd: number | null;
};

export type UserLaunchRow = {
  ticker: string;
  name: string;
  chain: ChainKey;
  status: string;
  token: string | null;
  createdAt: Date;
  quoteSymbol: string;
  /** Set for launches whose pool the indexer follows. */
  priceUsd: number | null;
  change24hPct: number | null;
  volumeAllUsd: number | null;
  creatorFeesQuote: number | null;
  creatorFeesUsd: number | null;
};
export type UserLaunches = { total: number; live: UserLaunchRow[]; pending: number; failed: number };

export type UserTradeRow = {
  side: "BUY" | "SELL";
  tokenSymbol: string;
  quoteSymbol: string;
  /** Human units: the quote asset for buys, tokens for sells. */
  amountIn: string;
  amountOut: string | null;
  status: string;
  createdAt: Date;
};
export type UserTrades = { total: number; recent: UserTradeRow[] };

export interface AskData {
  platformStats(chain: ChainScope): Promise<PlatformStats>;
  topTokens(chain: ChainScope, limit: number): Promise<TokenSummary[]>;
  /** Bot-launched tokens matching a ticker (any chain) or one address; at most a few. */
  findTokens(query: { ticker?: string | null; address?: string | null }): Promise<TokenSummary[]>;
  wallet(address: Address, xUserId: string): Promise<WalletSummary>;
  userLaunches(xUserId: string): Promise<UserLaunches>;
  userTrades(xUserId: string): Promise<UserTrades>;
}

export const TOKENS_SHOWN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const STABLE: Record<ChainKey, string> = { robinhood: "USDG", base: "USDC", arc: "USDC" };
const LIVE_LAUNCHES_DETAILED = 8;

const poolSelect = {
  token: true,
  chainId: true,
  quoteAddress: true,
  quoteDecimals: true,
  quoteSymbol: true,
  symbol: true,
  name: true,
  launchedAt: true,
  launchSupply: true,
  launch: { select: { creator: { select: { xHandle: true } } } },
} satisfies Prisma.PoolSelect;
type PoolRow = Prisma.PoolGetPayload<{ select: typeof poolSelect }>;

const toNum = (d: Prisma.Decimal | null | undefined): number | null => (d === null || d === undefined ? null : Number(d.toString()));
const toHuman = (d: Prisma.Decimal | null | undefined, decimals: number): number => (d ? Number(d.toString()) / 10 ** decimals : 0);
const keyOf = (chainId: number): ChainKey => chainKeyById(chainId) ?? "robinhood";
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Volumes = { volume24hQuote: number; volumeAllQuote: number; trades: number; feesQuote: number; usd: number | null };

/** Per-pool volumes in two aggregate queries, then one cached USD price per paired asset. */
async function poolVolumes(pools: PoolRow[], now: Date): Promise<Map<string, Volumes>> {
  const out = new Map<string, Volumes>();
  const tokens = pools.map((p) => p.token);
  if (tokens.length === 0) return out;
  const since = new Date(now.getTime() - DAY_MS);
  const [all, day] = await Promise.all([
    db().swap.groupBy({ by: ["token"], where: { token: { in: tokens } }, _sum: { amountQuote: true, feeQuote: true }, _count: { _all: true } }),
    db().swap.groupBy({ by: ["token"], where: { token: { in: tokens }, timestamp: { gte: since } }, _sum: { amountQuote: true } }),
  ]);
  const allBy = new Map(all.map((r) => [r.token, r]));
  const dayBy = new Map(day.map((r) => [r.token, r]));
  for (const p of pools) {
    const a = allBy.get(p.token);
    const d = dayBy.get(p.token);
    const usd = await quoteUsd(p.quoteAddress, p.quoteDecimals, keyOf(p.chainId)).catch(() => null);
    out.set(p.token, {
      volume24hQuote: toHuman(d?._sum.amountQuote, p.quoteDecimals),
      volumeAllQuote: toHuman(a?._sum.amountQuote, p.quoteDecimals),
      trades: a?._count._all ?? 0,
      feesQuote: toHuman(a?._sum.feeQuote, p.quoteDecimals),
      usd,
    });
  }
  return out;
}

/** Holder count from o1's Public API; null without a key or when the call fails. */
async function holdersCount(token: string, chainId: number): Promise<number | null> {
  const e = env();
  if (!e.O1_API_KEY) return null;
  try {
    const res = await fetch(`${e.O1_API_URL.replace(/\/$/, "")}/tokens/${chainId}/${token.toLowerCase()}/holders?limit=1`, {
      headers: { "x-api-key": e.O1_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { summary?: { total_holders?: unknown }; total?: unknown };
    const raw = json.summary?.total_holders ?? json.total;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
    return null;
  } catch (err) {
    logger.warn({ token, err: errMsg(err) }, "holders lookup failed");
    return null;
  }
}

async function summarize(pool: PoolRow, vol: Volumes | undefined, now: Date, opts: { holders: boolean }): Promise<TokenSummary> {
  const since = new Date(now.getTime() - DAY_MS);
  const order = { desc: [{ timestamp: "desc" as const }, { logIndex: "desc" as const }], asc: [{ timestamp: "asc" as const }, { logIndex: "asc" as const }] };
  const [last, before24, first, holders] = await Promise.all([
    db().swap.findFirst({ where: { token: pool.token }, orderBy: order.desc, select: { priceQuote: true } }),
    db().swap.findFirst({ where: { token: pool.token, timestamp: { lt: since } }, orderBy: order.desc, select: { priceQuote: true } }),
    db().swap.findFirst({ where: { token: pool.token }, orderBy: order.asc, select: { priceQuote: true } }),
    opts.holders ? holdersCount(pool.token, pool.chainId) : Promise.resolve(null),
  ]);
  const v = vol ?? { volume24hQuote: 0, volumeAllQuote: 0, trades: 0, feesQuote: 0, usd: null };
  const stats = computeStats({
    lastPrice: last ? toNum(last.priceQuote) : null,
    priceAt24hAgo: before24 ? toNum(before24.priceQuote) : null,
    volume24hQuote: v.volume24hQuote,
    volumeAllQuote: v.volumeAllQuote,
    supplyTokens: Number(pool.launchSupply.toString()) / 1e18,
    quoteUsd: v.usd,
    launchPrice: first ? toNum(first.priceQuote) : null,
  });
  return {
    token: pool.token,
    symbol: pool.symbol,
    name: pool.name,
    chain: keyOf(pool.chainId),
    quoteSymbol: pool.quoteSymbol,
    priceQuote: stats.priceQuote,
    priceUsd: stats.priceUsd,
    change24hPct: stats.change24hPct,
    volume24hUsd: stats.volume24hUsd,
    volumeAllUsd: stats.volumeAllUsd,
    mcapUsd: stats.mcapUsd,
    trades: v.trades,
    holders,
    launchedAt: pool.launchedAt,
    creatorHandle: pool.launch?.creator.xHandle ?? null,
    creatorFeesQuote: v.feesQuote / 2,
  };
}

function botPools(chain: ChainScope): Prisma.PoolWhereInput {
  return { source: "BOT", ...(chain ? { chainId: chainByKey(chain).id } : {}) };
}

export class LiveAskData implements AskData {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async platformStats(chain: ChainScope): Promise<PlatformStats> {
    const pools = await db().pool.findMany({ where: botPools(chain), select: poolSelect, orderBy: { launchedAt: "desc" } });
    const vols = await poolVolumes(pools, this.now());
    let trades = 0;
    let vol24: number | null = null;
    let volAll: number | null = null;
    for (const p of pools) {
      const v = vols.get(p.token);
      if (!v) continue;
      trades += v.trades;
      if (v.usd !== null) {
        vol24 = (vol24 ?? 0) + v.volume24hQuote * v.usd;
        volAll = (volAll ?? 0) + v.volumeAllQuote * v.usd;
      }
    }
    const count = (key: ChainKey) => pools.filter((p) => keyOf(p.chainId) === key).length;
    const newest = pools[0];
    return {
      launches: { total: pools.length, robinhood: count("robinhood"), base: count("base") },
      trades,
      volume24hUsd: vol24,
      volumeAllUsd: volAll,
      latest: newest ? { symbol: newest.symbol, chain: keyOf(newest.chainId), launchedAt: newest.launchedAt } : null,
    };
  }

  async topTokens(chain: ChainScope, limit: number): Promise<TokenSummary[]> {
    const pools = await db().pool.findMany({ where: botPools(chain), select: poolSelect });
    const now = this.now();
    const vols = await poolVolumes(pools, now);
    const score = (p: PoolRow) => {
      const v = vols.get(p.token);
      return v ? (v.usd !== null ? v.volume24hQuote * v.usd : v.volume24hQuote) : 0;
    };
    const top = [...pools].sort((a, b) => score(b) - score(a) || b.launchedAt.getTime() - a.launchedAt.getTime()).slice(0, limit);
    return Promise.all(top.map((p) => summarize(p, vols.get(p.token), now, { holders: false })));
  }

  async findTokens(query: { ticker?: string | null; address?: string | null }): Promise<TokenSummary[]> {
    const where: Prisma.PoolWhereInput | null = query.address ? { token: getAddress(query.address) } : query.ticker ? { symbol: { equals: query.ticker, mode: "insensitive" } } : null;
    if (!where) return [];
    const pools = await db().pool.findMany({ where: { source: "BOT", ...where }, select: poolSelect, orderBy: { launchedAt: "asc" }, take: 3 });
    const now = this.now();
    const vols = await poolVolumes(pools, now);
    return Promise.all(pools.map((p) => summarize(p, vols.get(p.token), now, { holders: true })));
  }

  async wallet(address: Address, xUserId: string): Promise<WalletSummary> {
    const wallet = getAddress(address);
    const out: WalletSummary = { address: wallet, eth: [], quotes: [], tokens: [], tokensCount: 0, feesOwed: [], totalUsd: null };
    const add = (usd: number | null) => {
      if (usd !== null) out.totalUsd = (out.totalUsd ?? 0) + usd;
    };
    const tokenRows: Array<BalanceRow & { chain: ChainKey }> = [];
    for (const key of INDEXED_CHAIN_KEYS) {
      try {
        const chainId = chainByKey(key).id;
        const client = publicClient(key);
        const [pools, launchQuotes] = await Promise.all([
          db().pool.findMany({ where: botPools(key), select: poolSelect }),
          db().launch.findMany({ where: { creator: { xUserId }, chainId }, select: { quoteAddress: true }, distinct: ["quoteAddress"] }),
        ]);
        const stable = findQuote(key, STABLE[key]);
        const quoteAddrs = [...new Set<string>([...(stable ? [stable.address] : []), ...launchQuotes.map((l) => getAddress(l.quoteAddress))])].filter((a) => a !== zeroAddress) as Address[];
        const erc20s: Array<{ address: Address; kind: "quote" | "token"; pool?: PoolRow }> = [
          ...quoteAddrs.map((a) => ({ address: a, kind: "quote" as const })),
          ...pools.map((p) => ({ address: getAddress(p.token), kind: "token" as const, pool: p })),
        ];
        const [ethBalance, balances, ethUsd] = await Promise.all([
          client.getBalance({ address: wallet }),
          erc20s.length ? client.multicall({ allowFailure: true, contracts: erc20s.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }) as const) }) : Promise.resolve([]),
          quoteUsd(zeroAddress, 18, key).catch(() => null),
        ]);
        const ethHuman = formatUnits(ethBalance, 18);
        const ethUsdValue = ethUsd === null ? null : Number(ethHuman) * ethUsd;
        out.eth.push({ chain: key, eth: ethHuman, usd: ethUsdValue });
        add(ethUsdValue);

        for (const [i, t] of erc20s.entries()) {
          const r = balances[i];
          if (!r || r.status !== "success" || (r.result as bigint) === 0n) continue;
          const raw = r.result as bigint;
          if (t.kind === "quote") {
            const q = findQuote(key, t.address);
            if (!q) continue;
            const human = formatUnits(raw, q.decimals);
            const px = q.symbol === STABLE[key] ? 1 : await quoteUsd(q.address, q.decimals, key).catch(() => null);
            const usd = px === null ? null : Number(human) * px;
            out.quotes.push({ chain: key, symbol: q.symbol, balance: human, usd });
            add(usd);
          } else if (t.pool) {
            const human = formatUnits(raw, 18);
            const last = await db().swap.findFirst({ where: { token: t.pool.token }, orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }], select: { priceQuote: true } });
            const px = last ? toNum(last.priceQuote) : null;
            const qUsd = px === null ? null : await quoteUsd(t.pool.quoteAddress, t.pool.quoteDecimals, key).catch(() => null);
            const usd = px !== null && qUsd !== null ? Number(human) * px * qUsd : null;
            tokenRows.push({ chain: key, symbol: t.pool.symbol, balance: human, usd });
            add(usd);
          }
        }

        // Creator fees waiting in o1's escrow on this chain: what it owes the wallet itself (launches made
        // before the fee splitter) plus the recipients' share of what it owes the splitter clones of this
        // account's launches, as creator or as the account fees were directed to.
        const escrow = activeFeeEscrow(key);
        const splitLaunches = await db().launch.findMany({
          where: { chainId, feeSplitter: { not: null }, tokenAddress: { not: null }, OR: [{ creator: { xUserId } }, { feeRecipient: { xUserId } }] },
          select: { feeSplitter: true, feeSplitterConfig: true, quoteAddress: true },
        });
        const splitters = splitLaunches.flatMap((l) => {
          const config = parseFeeSplitConfig(l.feeSplitterConfig);
          return l.feeSplitter && config ? [{ splitter: getAddress(l.feeSplitter), currency: getAddress(l.quoteAddress), platformBps: config.platformBps }] : [];
        });
        const currencies = [zeroAddress, ...quoteAddrs] as Address[];
        const owed = await client.multicall({
          allowFailure: true,
          contracts: [
            ...currencies.map((c) => ({ address: escrow, abi: feeEscrowAbi, functionName: "owed", args: [wallet, c] }) as const),
            ...splitters.map((s) => ({ address: escrow, abi: feeEscrowAbi, functionName: "owed", args: [s.splitter, s.currency] }) as const),
          ],
        });
        const owedByCurrency = new Map<Address, bigint>();
        const credit = (currency: Address, amount: bigint) => {
          if (amount > 0n) owedByCurrency.set(currency, (owedByCurrency.get(currency) ?? 0n) + amount);
        };
        currencies.forEach((c, i) => {
          const r = owed[i];
          if (r?.status === "success") credit(c, r.result as bigint);
        });
        splitters.forEach((s, i) => {
          const r = owed[currencies.length + i];
          if (r?.status === "success") credit(s.currency, recipientShareOf(r.result as bigint, s.platformBps));
        });
        for (const [currency, amount] of owedByCurrency) {
          const q = currency === zeroAddress ? { symbol: "ETH", decimals: 18, address: zeroAddress } : findQuote(key, currency);
          if (!q) continue;
          const human = formatUnits(amount, q.decimals);
          const px = currency === zeroAddress ? ethUsd : q.symbol === STABLE[key] ? 1 : await quoteUsd(currency, q.decimals, key).catch(() => null);
          out.feesOwed.push({ chain: key, symbol: q.symbol, balance: human, usd: px === null ? null : Number(human) * px });
        }
      } catch (err) {
        logger.warn({ chain: key, err: errMsg(err) }, "wallet lookup failed on one chain; answering with the rest");
      }
    }
    tokenRows.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || Number(b.balance) - Number(a.balance));
    out.tokensCount = tokenRows.length;
    out.tokens = tokenRows.slice(0, TOKENS_SHOWN);
    return out;
  }

  async userLaunches(xUserId: string): Promise<UserLaunches> {
    const rows = await db().launch.findMany({
      where: { creator: { xUserId } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { ticker: true, name: true, chainId: true, status: true, tokenAddress: true, createdAt: true, quoteSymbol: true, quoteAddress: true, pool: { select: poolSelect } },
    });
    const now = this.now();
    const livePools = rows.map((r) => r.pool).filter((p): p is PoolRow => p !== null);
    const vols = await poolVolumes(livePools, now);
    const live: UserLaunchRow[] = [];
    let detailed = 0;
    for (const r of rows) {
      if (!r.pool) continue;
      const v = vols.get(r.pool.token);
      const summary = detailed < LIVE_LAUNCHES_DETAILED ? await summarize(r.pool, v, now, { holders: false }) : null;
      detailed++;
      const feesQuote = v ? v.feesQuote / 2 : null;
      const feesUsd = feesQuote !== null && v?.usd !== null && v?.usd !== undefined ? feesQuote * v.usd : null;
      live.push({
        ticker: r.ticker,
        name: r.name,
        chain: keyOf(r.chainId),
        status: r.status,
        token: r.pool.token,
        createdAt: r.createdAt,
        quoteSymbol: r.quoteSymbol,
        priceUsd: summary?.priceUsd ?? null,
        change24hPct: summary?.change24hPct ?? null,
        volumeAllUsd: summary?.volumeAllUsd ?? (v && v.usd !== null ? v.volumeAllQuote * v.usd : null),
        creatorFeesQuote: feesQuote,
        creatorFeesUsd: feesUsd,
      });
    }
    const pending = rows.filter((r) => !r.pool && ["QUEUED", "SIMULATING", "SIGNING", "BROADCAST", "CONFIRMED", "FEE_RECIPIENT_PENDING", "REPLIED"].includes(r.status)).length;
    const failed = rows.filter((r) => r.status === "FAILED").length;
    return { total: rows.length, live, pending, failed };
  }

  async userTrades(xUserId: string): Promise<UserTrades> {
    const [total, rows] = await Promise.all([
      db().trade.count({ where: { user: { xUserId }, status: { in: COUNTED_TRADE_STATUSES } } }),
      db().trade.findMany({ where: { user: { xUserId } }, orderBy: { createdAt: "desc" }, take: 5 }),
    ]);
    return {
      total,
      recent: rows.map((t) => {
        const quoteDecimals = t.quoteDecimals ?? 18;
        const inDecimals = t.side === "BUY" ? quoteDecimals : 18;
        const outDecimals = t.side === "BUY" ? 18 : quoteDecimals;
        return {
          side: t.side,
          tokenSymbol: t.tokenSymbol ?? `${t.token.slice(0, 6)}…${t.token.slice(-4)}`,
          quoteSymbol: t.quoteSymbol ?? "ETH",
          amountIn: formatUnits(BigInt(t.amountInWei), inDecimals),
          amountOut: t.amountOut ? formatUnits(BigInt(t.amountOut), outDecimals) : null,
          status: t.status,
          createdAt: t.createdAt,
        };
      }),
    };
  }
}

export function liveAskData(now?: () => Date): AskData {
  return new LiveAskData(now);
}

/** Seeded by tests; empty by default, which is also what a DB-less dry run answers with. */
export class MemoryAskData implements AskData {
  stats: PlatformStats = { launches: { total: 0, robinhood: 0, base: 0 }, trades: 0, volume24hUsd: null, volumeAllUsd: null, latest: null };
  tokens: TokenSummary[] = [];
  wallets = new Map<string, WalletSummary>();
  launches = new Map<string, UserLaunches>();
  trades = new Map<string, UserTrades>();

  async platformStats(): Promise<PlatformStats> {
    return this.stats;
  }
  async topTokens(chain: ChainScope, limit: number): Promise<TokenSummary[]> {
    return this.tokens
      .filter((t) => !chain || t.chain === chain)
      .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
      .slice(0, limit);
  }
  async findTokens(query: { ticker?: string | null; address?: string | null }): Promise<TokenSummary[]> {
    if (query.address) return this.tokens.filter((t) => t.token.toLowerCase() === query.address!.toLowerCase());
    if (query.ticker) return this.tokens.filter((t) => t.symbol.toLowerCase() === query.ticker!.toLowerCase()).slice(0, 3);
    return [];
  }
  async wallet(address: Address): Promise<WalletSummary> {
    return this.wallets.get(address.toLowerCase()) ?? { address, eth: [], quotes: [], tokens: [], tokensCount: 0, feesOwed: [], totalUsd: null };
  }
  async userLaunches(xUserId: string): Promise<UserLaunches> {
    return this.launches.get(xUserId) ?? { total: 0, live: [], pending: 0, failed: 0 };
  }
  async userTrades(xUserId: string): Promise<UserTrades> {
    return this.trades.get(xUserId) ?? { total: 0, recent: [] };
  }
}
