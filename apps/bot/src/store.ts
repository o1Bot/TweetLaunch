import { getAddress } from "viem";
import { db, Prisma } from "@o1bot/db";
import type { FeeSplitConfig } from "@o1bot/shared";

/**
 * Persistence the pipeline needs, behind an interface so tests and dry runs
 * can use the in-memory version. Dedupe is a database constraint
 * (Mention.tweetId is unique), so a post can never be processed twice even
 * across restarts or several workers.
 */

export type MentionStatusValue = "RECEIVED" | "PARSED" | "CLARIFY" | "NOT_REGISTERED" | "REJECTED" | "QUEUED" | "DONE" | "FAILED";
export type LaunchStatusValue = "DRY_RUN" | "QUEUED" | "SIMULATING" | "SIGNING" | "BROADCAST" | "CONFIRMED" | "FEE_RECIPIENT_PENDING" | "REPLIED" | "FAILED";
export type SignedTxKindValue = "CREATE_LAUNCH" | "CREATE_LAUNCH_AND_BUY" | "ERC20_APPROVE" | "SET_CREATOR_FEE_RECIPIENT" | "FEE_CLAIM" | "PERMIT2_APPROVE" | "ROUTER_EXECUTE" | "RELAY_DEPOSIT";
export type BridgeStatusValue = "DRY_RUN" | "QUEUED" | "SIGNING" | "DEPOSITED" | "FILLED" | "FAILED";
/** Bridge statuses that count against a user's rate limits. */
export const COUNTED_BRIDGE_STATUSES: BridgeStatusValue[] = ["DRY_RUN", "SIGNING", "DEPOSITED", "FILLED"];
export type TradeStatusValue = "DRY_RUN" | "QUEUED" | "SIGNING" | "CONFIRMED" | "REPLIED" | "FAILED";
/** Trade statuses that count against a user's rate limits. */
export const COUNTED_TRADE_STATUSES: TradeStatusValue[] = ["DRY_RUN", "SIGNING", "CONFIRMED", "REPLIED"];

/** Launch statuses that count against a user's rate limits. */
export const COUNTED_LAUNCH_STATUSES: LaunchStatusValue[] = ["DRY_RUN", "SIGNING", "BROADCAST", "CONFIRMED", "FEE_RECIPIENT_PENDING", "REPLIED"];

export type NewMention = {
  tweetId: string;
  authorXUserId: string;
  authorHandle: string;
  text: string;
  mediaUrl: string | null;
  language: string | null;
  postedAt: Date | null;
};

export type MentionRecord = { id: string; tweetId: string; authorXUserId: string; authorHandle: string; language: string | null };

export type MentionPatch = { status?: MentionStatusValue; parse?: unknown; error?: string | null; replyTweetId?: string | null; language?: string | null };

export type UserUpsert = {
  xUserId: string;
  xHandle: string;
  xName?: string | null;
  xAvatarUrl?: string | null;
  privyUserId?: string | null;
  walletAddress?: string | null;
  walletId?: string | null;
  pregenerated?: boolean;
  delegated?: boolean;
  linkedAt?: Date | null;
};

export type LaunchSourceValue = "X" | "WEB";

/** What the web form submitted, kept on the row until the worker has used it. */
export type WebLaunchRequest = {
  devBuyNative: string | null;
  description: string | null;
  website: string | null;
  telegram: string | null;
  xHandle: string | null;
  feesToHandle: string | null;
  /** Subdomain label for a website the form asked for, already checked; null or absent when none. */
  siteSlug?: string | null;
};

export type NewLaunch = {
  /** The originating post for X launches; null for web launches. */
  mentionId: string | null;
  source: LaunchSourceValue;
  creatorUserId: string;
  feeRecipientUserId: string | null;
  chainId: number;
  factory: string;
  quoteAddress: string;
  quoteSymbol: string;
  ticker: string;
  name: string;
  devBuyWei: bigint | null;
  imageUri: string | null;
  metadataUri: string | null;
  status: LaunchStatusValue;
  request?: WebLaunchRequest | null;
  imageData?: Uint8Array | null;
  imageMime?: string | null;
};

export type LaunchPatch = {
  status?: LaunchStatusValue;
  tokenAddress?: string | null;
  poolId?: string | null;
  launchTxHash?: string | null;
  feeRecipientTxHash?: string | null;
  /** o1bot's fee splitter clone used as o1's creator fee recipient, its configuration and its register transaction. */
  feeSplitter?: string | null;
  feeSplitterConfig?: FeeSplitConfig;
  feeSplitterTxHash?: string | null;
  error?: string | null;
  creatorSalt?: string | null;
  metadataUri?: string | null;
  imageUri?: string | null;
  userMessage?: string | null;
  /** Set to null once the uploaded logo has been pinned. */
  imageData?: Uint8Array | null;
};

/** A queued web launch handed to the worker, with what it needs to run it. */
export type WebLaunchJob = {
  id: string;
  createdAt: Date;
  creator: { id: string; xUserId: string; xHandle: string };
  ticker: string;
  name: string;
  quoteAddress: string;
  devBuyWei: bigint | null;
  request: WebLaunchRequest;
  imageData: Uint8Array | null;
};

/** An o1 launch pool, as much of it as a trade needs: the bot's own launches or a token from o1's directory. */
export type TradableToken = {
  token: string;
  symbol: string;
  name: string;
  quoteAddress: string;
  quoteSymbol: string;
  quoteDecimals: number;
  tickSpacing: number;
  hook: string;
  poolId: string;
  launchedAt: Date;
  source: "bot" | "o1";
  /** From o1's market data, for ranking candidates that share a ticker; null when unknown. */
  liquidityUsd: number | null;
};

export type TradingSettings = { enabled: boolean; maxTradeWei: bigint | null };
/** What the user chose on the profile about being talked to and being named. */
export type UserPrefs = { acceptFeeRedirects: boolean; replyLanguage: "auto" | "en" };

export type NewTrade = {
  mentionId: string | null;
  userId: string;
  chainId: number;
  token: string;
  tokenSymbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  side: "BUY" | "SELL";
  amountInWei: bigint;
  minAmountOut: bigint | null;
  slippageBps: number;
  status: TradeStatusValue;
};

export type TradePatch = {
  status?: TradeStatusValue;
  amountOut?: bigint | null;
  minAmountOut?: bigint | null;
  txHash?: string | null;
  error?: string | null;
  userMessage?: string | null;
};

export type NewBridge = {
  mentionId: string | null;
  userId: string;
  originChainId: number;
  amountInWei: bigint;
  requestId: string | null;
  status: BridgeStatusValue;
};

export type BridgePatch = {
  status?: BridgeStatusValue;
  amountOutWei?: bigint | null;
  depositTxHash?: string | null;
  fillTxHash?: string | null;
  error?: string | null;
  userMessage?: string | null;
};

export type SignedTxRecord = {
  launchId: string | null;
  tweetId: string;
  xUserId: string;
  wallet: string;
  chainId: number;
  kind: SignedTxKindValue;
  to: string;
  calldataHash: string;
  valueWei: string;
  txHash?: string | null;
};

export interface BotStore {
  getCursor(id: string): Promise<string | null>;
  /** A processed post by row id, for replies that come later (a site that finished building). */
  getMention(id: string): Promise<MentionRecord | null>;
  setCursor(id: string, value: string): Promise<void>;
  insertMention(m: NewMention): Promise<{ id: string; created: boolean }>;
  updateMention(id: string, patch: MentionPatch): Promise<void>;
  launchCountSince(xUserId: string, since: Date): Promise<number>;
  lastLaunchAt(xUserId: string): Promise<Date | null>;
  replyCountSince(xUserId: string, since: Date): Promise<number>;
  upsertUser(u: UserUpsert): Promise<{ id: string }>;
  createLaunch(l: NewLaunch): Promise<{ id: string }>;
  updateLaunch(id: string, patch: LaunchPatch): Promise<void>;
  recordSignedTx(rec: SignedTxRecord): Promise<void>;
  /**
   * Operator use only (`once --post`): forget a post so it can be processed
   * again, e.g. after a dry run. Refused when anything was ever signed for it.
   */
  resetMentionForRerun(tweetId: string): Promise<{ reset: boolean; reason: string }>;
  /** Oldest queued web launch, atomically moved to SIMULATING so no other worker takes it. Null when none. */
  claimQueuedWebLaunch(): Promise<WebLaunchJob | null>;
  /** Bot-launched pools matching a ticker (case-insensitive, oldest first) or exactly one address. */
  findTradableTokens(query: { ticker?: string | null; address?: string | null }): Promise<TradableToken[]>;
  /** The user's trading opt-in and cap; null when the user is unknown. */
  tradingSettings(xUserId: string): Promise<TradingSettings | null>;
  /** Profile preferences; defaults for an unknown user. */
  userPrefs(xUserId: string): Promise<UserPrefs>;
  tradeCountSince(xUserId: string, since: Date): Promise<number>;
  lastTradeAt(xUserId: string): Promise<Date | null>;
  createTrade(t: NewTrade): Promise<{ id: string }>;
  updateTrade(id: string, patch: TradePatch): Promise<void>;
  bridgeCountSince(xUserId: string, since: Date): Promise<number>;
  lastBridgeAt(xUserId: string): Promise<Date | null>;
  createBridge(b: NewBridge): Promise<{ id: string }>;
  updateBridge(id: string, patch: BridgePatch): Promise<void>;
}

export class PrismaBotStore implements BotStore {
  async getMention(id: string) {
    const row = await db().mention.findUnique({ where: { id }, select: { id: true, tweetId: true, authorXUserId: true, authorHandle: true, language: true } });
    return row ?? null;
  }
  async getCursor(id: string) {
    const row = await db().botCursor.findUnique({ where: { id } });
    return row?.value ?? null;
  }
  async setCursor(id: string, value: string) {
    await db().botCursor.upsert({ where: { id }, create: { id, value }, update: { value } });
  }
  async insertMention(m: NewMention) {
    try {
      const row = await db().mention.create({ data: { ...m, status: "RECEIVED" }, select: { id: true } });
      return { id: row.id, created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await db().mention.findUnique({ where: { tweetId: m.tweetId }, select: { id: true } });
        if (existing) return { id: existing.id, created: false };
      }
      throw err;
    }
  }
  async updateMention(id: string, patch: MentionPatch) {
    const { parse, ...rest } = patch;
    await db().mention.update({ where: { id }, data: { ...rest, ...(parse !== undefined ? { parse: parse as Prisma.InputJsonValue } : {}) } });
  }
  async launchCountSince(xUserId: string, since: Date) {
    return db().launch.count({ where: { creator: { xUserId }, status: { in: COUNTED_LAUNCH_STATUSES }, createdAt: { gte: since } } });
  }
  async lastLaunchAt(xUserId: string) {
    const row = await db().launch.findFirst({ where: { creator: { xUserId }, status: { in: COUNTED_LAUNCH_STATUSES } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }
  async replyCountSince(xUserId: string, since: Date) {
    return db().mention.count({ where: { authorXUserId: xUserId, replyTweetId: { not: null }, receivedAt: { gte: since } } });
  }
  async upsertUser(u: UserUpsert) {
    const { xUserId, ...rest } = u;
    const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const row = await db().user.upsert({ where: { xUserId }, create: { xUserId, xHandle: u.xHandle, ...data }, update: data, select: { id: true } });
    return { id: row.id };
  }
  async createLaunch(l: NewLaunch) {
    const row = await db().launch.create({
      data: {
        mentionId: l.mentionId,
        source: l.source,
        creatorId: l.creatorUserId,
        feeRecipientId: l.feeRecipientUserId,
        chainId: l.chainId,
        factory: l.factory,
        quoteAddress: l.quoteAddress,
        quoteSymbol: l.quoteSymbol,
        ticker: l.ticker,
        name: l.name,
        devBuyWei: l.devBuyWei === null ? null : l.devBuyWei.toString(),
        imageUri: l.imageUri,
        metadataUri: l.metadataUri,
        status: l.status,
        request: l.request ? (l.request as Prisma.InputJsonValue) : undefined,
        imageData: l.imageData ? new Uint8Array(l.imageData) : undefined,
        imageMime: l.imageMime ?? undefined,
      },
      select: { id: true },
    });
    return { id: row.id };
  }
  async updateLaunch(id: string, patch: LaunchPatch) {
    const { imageData, ...rest } = patch;
    await db().launch.update({ where: { id }, data: { ...rest, ...(imageData !== undefined ? { imageData: imageData ? new Uint8Array(imageData) : null } : {}) } });
  }
  async claimQueuedWebLaunch() {
    const candidate = await db().launch.findFirst({
      where: { source: "WEB", status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      include: { creator: { select: { id: true, xUserId: true, xHandle: true } } },
    });
    if (!candidate) return null;
    const claimed = await db().launch.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "SIMULATING" } });
    if (claimed.count === 0) return null;
    const request = (candidate.request ?? {}) as Partial<WebLaunchRequest>;
    return {
      id: candidate.id,
      createdAt: candidate.createdAt,
      creator: candidate.creator,
      ticker: candidate.ticker,
      name: candidate.name,
      quoteAddress: candidate.quoteAddress,
      devBuyWei: candidate.devBuyWei ? BigInt(candidate.devBuyWei) : null,
      request: {
        devBuyNative: request.devBuyNative ?? null,
        description: request.description ?? null,
        website: request.website ?? null,
        telegram: request.telegram ?? null,
        xHandle: request.xHandle ?? null,
        feesToHandle: request.feesToHandle ?? null,
        siteSlug: request.siteSlug ?? null,
      },
      imageData: candidate.imageData ? new Uint8Array(candidate.imageData) : null,
    };
  }
  async recordSignedTx(rec: SignedTxRecord) {
    await db().signedTransaction.create({ data: { ...rec, txHash: rec.txHash ?? null } });
  }
  async findTradableTokens(query: { ticker?: string | null; address?: string | null }) {
    const where = query.address ? { token: getAddress(query.address) } : query.ticker ? { symbol: { equals: query.ticker, mode: "insensitive" as const } } : null;
    if (!where) return [];
    const rows = await db().pool.findMany({
      where: { source: "BOT", ...where },
      orderBy: { launchedAt: "asc" },
      select: { token: true, symbol: true, name: true, quoteAddress: true, quoteSymbol: true, quoteDecimals: true, tickSpacing: true, hook: true, poolId: true, launchedAt: true },
    });
    return rows.map((r) => ({ ...r, source: "bot" as const, liquidityUsd: null }));
  }
  async tradingSettings(xUserId: string) {
    const row = await db().user.findUnique({ where: { xUserId }, select: { tradingEnabled: true, maxTradeWei: true } });
    if (!row) return null;
    return { enabled: row.tradingEnabled, maxTradeWei: row.maxTradeWei ? BigInt(row.maxTradeWei) : null };
  }
  async userPrefs(xUserId: string): Promise<UserPrefs> {
    const row = await db().user.findUnique({ where: { xUserId }, select: { acceptFeeRedirects: true, replyLanguage: true } });
    return { acceptFeeRedirects: row?.acceptFeeRedirects ?? true, replyLanguage: row?.replyLanguage === "en" ? "en" : "auto" };
  }
  async tradeCountSince(xUserId: string, since: Date) {
    return db().trade.count({ where: { user: { xUserId }, status: { in: COUNTED_TRADE_STATUSES }, createdAt: { gte: since } } });
  }
  async lastTradeAt(xUserId: string) {
    const row = await db().trade.findFirst({ where: { user: { xUserId }, status: { in: COUNTED_TRADE_STATUSES } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }
  async createTrade(t: NewTrade) {
    const row = await db().trade.create({
      data: {
        mentionId: t.mentionId,
        userId: t.userId,
        chainId: t.chainId,
        token: t.token,
        tokenSymbol: t.tokenSymbol,
        quoteSymbol: t.quoteSymbol,
        quoteDecimals: t.quoteDecimals,
        side: t.side,
        amountInWei: t.amountInWei.toString(),
        minAmountOut: t.minAmountOut === null ? null : t.minAmountOut.toString(),
        slippageBps: t.slippageBps,
        status: t.status,
      },
      select: { id: true },
    });
    return { id: row.id };
  }
  async updateTrade(id: string, patch: TradePatch) {
    const { amountOut, minAmountOut, ...rest } = patch;
    await db().trade.update({
      where: { id },
      data: {
        ...rest,
        ...(amountOut !== undefined ? { amountOut: amountOut === null ? null : amountOut.toString() } : {}),
        ...(minAmountOut !== undefined ? { minAmountOut: minAmountOut === null ? null : minAmountOut.toString() } : {}),
      },
    });
  }
  async bridgeCountSince(xUserId: string, since: Date) {
    return db().bridge.count({ where: { user: { xUserId }, status: { in: COUNTED_BRIDGE_STATUSES }, createdAt: { gte: since } } });
  }
  async lastBridgeAt(xUserId: string) {
    const row = await db().bridge.findFirst({ where: { user: { xUserId }, status: { in: COUNTED_BRIDGE_STATUSES } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }
  async createBridge(b: NewBridge) {
    const row = await db().bridge.create({
      data: { mentionId: b.mentionId, userId: b.userId, originChainId: b.originChainId, amountInWei: b.amountInWei.toString(), requestId: b.requestId, status: b.status },
      select: { id: true },
    });
    return { id: row.id };
  }
  async updateBridge(id: string, patch: BridgePatch) {
    const { amountOutWei, ...rest } = patch;
    await db().bridge.update({ where: { id }, data: { ...rest, ...(amountOutWei !== undefined ? { amountOutWei: amountOutWei === null ? null : amountOutWei.toString() } : {}) } });
  }
  async resetMentionForRerun(tweetId: string) {
    const mention = await db().mention.findUnique({ where: { tweetId }, include: { launch: { include: { signedTxs: true, pool: true } } } });
    if (!mention) return { reset: false, reason: "never processed" };
    if (mention.launch?.signedTxs.length) return { reset: false, reason: `a transaction was already signed for this post (launch ${mention.launch.id})` };
    if (mention.launch?.pool) return { reset: false, reason: `this post already produced a live pool (${mention.launch.pool.token})` };
    await db().$transaction(async (tx) => {
      if (mention.launch) await tx.launch.delete({ where: { id: mention.launch.id } });
      await tx.mention.delete({ where: { id: mention.id } });
    });
    return { reset: true, reason: mention.launch ? `previous launch ${mention.launch.status} removed` : "previous mention removed" };
  }
}

export class MemoryBotStore implements BotStore {
  cursors = new Map<string, string>();
  mentions: Array<NewMention & { id: string; status: MentionStatusValue; parse?: unknown; error?: string | null; replyTweetId?: string | null; receivedAt: Date }> = [];
  users: Array<UserUpsert & { id: string }> = [];
  launches: Array<NewLaunch & { id: string; createdAt: Date } & LaunchPatch> = [];
  signedTxs: SignedTxRecord[] = [];
  /** Seeded by tests: pools the bot launched. */
  pools: TradableToken[] = [];
  trading = new Map<string, TradingSettings>();
  prefs = new Map<string, UserPrefs>();
  trades: Array<NewTrade & { id: string; createdAt: Date } & TradePatch> = [];
  bridges: Array<NewBridge & { id: string; createdAt: Date } & BridgePatch> = [];
  private seq = 0;
  now: () => Date = () => new Date();

  async getMention(id: string) {
    const m = this.mentions.find((x) => x.id === id);
    return m ? { id: m.id, tweetId: m.tweetId, authorXUserId: m.authorXUserId, authorHandle: m.authorHandle, language: m.language } : null;
  }
  async getCursor(id: string) {
    return this.cursors.get(id) ?? null;
  }
  async setCursor(id: string, value: string) {
    this.cursors.set(id, value);
  }
  async insertMention(m: NewMention) {
    const existing = this.mentions.find((x) => x.tweetId === m.tweetId);
    if (existing) return { id: existing.id, created: false };
    const id = `m${++this.seq}`;
    this.mentions.push({ ...m, id, status: "RECEIVED", receivedAt: this.now() });
    return { id, created: true };
  }
  async updateMention(id: string, patch: MentionPatch) {
    const row = this.mentions.find((x) => x.id === id);
    if (row) Object.assign(row, patch);
  }
  private userXId(userId: string) {
    return this.users.find((u) => u.id === userId)?.xUserId;
  }
  async launchCountSince(xUserId: string, since: Date) {
    return this.launches.filter((l) => this.userXId(l.creatorUserId) === xUserId && COUNTED_LAUNCH_STATUSES.includes(l.status) && l.createdAt >= since).length;
  }
  async lastLaunchAt(xUserId: string) {
    const rows = this.launches.filter((l) => this.userXId(l.creatorUserId) === xUserId && COUNTED_LAUNCH_STATUSES.includes(l.status));
    return rows.length ? rows[rows.length - 1]!.createdAt : null;
  }
  async replyCountSince(xUserId: string, since: Date) {
    return this.mentions.filter((m) => m.authorXUserId === xUserId && m.replyTweetId && m.receivedAt >= since).length;
  }
  async upsertUser(u: UserUpsert) {
    const existing = this.users.find((x) => x.xUserId === u.xUserId);
    if (existing) {
      Object.assign(existing, Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)));
      return { id: existing.id };
    }
    const id = `u${++this.seq}`;
    this.users.push({ ...u, id });
    return { id };
  }
  async createLaunch(l: NewLaunch) {
    const id = `l${++this.seq}`;
    this.launches.push({ ...l, id, createdAt: this.now() });
    return { id };
  }
  async claimQueuedWebLaunch() {
    const row = this.launches.find((l) => l.source === "WEB" && l.status === "QUEUED");
    if (!row) return null;
    row.status = "SIMULATING";
    const creator = this.users.find((u) => u.id === row.creatorUserId);
    return {
      id: row.id,
      createdAt: row.createdAt,
      creator: { id: row.creatorUserId, xUserId: creator?.xUserId ?? "", xHandle: creator?.xHandle ?? "" },
      ticker: row.ticker,
      name: row.name,
      quoteAddress: row.quoteAddress,
      devBuyWei: row.devBuyWei,
      request: row.request ?? { devBuyNative: null, description: null, website: null, telegram: null, xHandle: null, feesToHandle: null },
      imageData: row.imageData ?? null,
    };
  }
  async updateLaunch(id: string, patch: LaunchPatch) {
    const row = this.launches.find((x) => x.id === id);
    if (row) Object.assign(row, patch);
  }
  async recordSignedTx(rec: SignedTxRecord) {
    this.signedTxs.push(rec);
  }
  async findTradableTokens(query: { ticker?: string | null; address?: string | null }) {
    if (query.address) return this.pools.filter((p) => p.token.toLowerCase() === query.address!.toLowerCase());
    if (query.ticker) return this.pools.filter((p) => p.symbol.toLowerCase() === query.ticker!.toLowerCase()).sort((a, b) => a.launchedAt.getTime() - b.launchedAt.getTime());
    return [];
  }
  async tradingSettings(xUserId: string) {
    return this.trading.get(xUserId) ?? (this.users.some((u) => u.xUserId === xUserId) ? { enabled: false, maxTradeWei: null } : null);
  }
  async userPrefs(xUserId: string): Promise<UserPrefs> {
    return this.prefs.get(xUserId) ?? { acceptFeeRedirects: true, replyLanguage: "auto" };
  }
  async tradeCountSince(xUserId: string, since: Date) {
    return this.trades.filter((t) => this.userXId(t.userId) === xUserId && COUNTED_TRADE_STATUSES.includes(t.status) && t.createdAt >= since).length;
  }
  async lastTradeAt(xUserId: string) {
    const rows = this.trades.filter((t) => this.userXId(t.userId) === xUserId && COUNTED_TRADE_STATUSES.includes(t.status));
    return rows.length ? rows[rows.length - 1]!.createdAt : null;
  }
  async createTrade(t: NewTrade) {
    const id = `t${++this.seq}`;
    this.trades.push({ ...t, id, createdAt: this.now() });
    return { id };
  }
  async updateTrade(id: string, patch: TradePatch) {
    const row = this.trades.find((x) => x.id === id);
    if (row) Object.assign(row, patch);
  }
  async bridgeCountSince(xUserId: string, since: Date) {
    return this.bridges.filter((b) => this.userXId(b.userId) === xUserId && COUNTED_BRIDGE_STATUSES.includes(b.status) && b.createdAt >= since).length;
  }
  async lastBridgeAt(xUserId: string) {
    const rows = this.bridges.filter((b) => this.userXId(b.userId) === xUserId && COUNTED_BRIDGE_STATUSES.includes(b.status));
    return rows.length ? rows[rows.length - 1]!.createdAt : null;
  }
  async createBridge(b: NewBridge) {
    const id = `b${++this.seq}`;
    this.bridges.push({ ...b, id, createdAt: this.now() });
    return { id };
  }
  async updateBridge(id: string, patch: BridgePatch) {
    const row = this.bridges.find((x) => x.id === id);
    if (row) Object.assign(row, patch);
  }
  async resetMentionForRerun(tweetId: string) {
    const mention = this.mentions.find((m) => m.tweetId === tweetId);
    if (!mention) return { reset: false, reason: "never processed" };
    const launch = this.launches.find((l) => l.mentionId === mention.id);
    if (launch && this.signedTxs.some((t) => t.launchId === launch.id)) return { reset: false, reason: `a transaction was already signed for this post (launch ${launch.id})` };
    this.launches = this.launches.filter((l) => l.mentionId !== mention.id);
    this.mentions = this.mentions.filter((m) => m.id !== mention.id);
    return { reset: true, reason: launch ? `previous launch ${launch.status} removed` : "previous mention removed" };
  }
}
