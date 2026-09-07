import { db, Prisma } from "@o1bot/db";

/**
 * Persistence the pipeline needs, behind an interface so tests and dry runs
 * can use the in-memory version. Dedupe is a database constraint
 * (Mention.tweetId is unique), so a post can never be processed twice even
 * across restarts or several workers.
 */

export type MentionStatusValue = "RECEIVED" | "PARSED" | "CLARIFY" | "NOT_REGISTERED" | "REJECTED" | "QUEUED" | "DONE" | "FAILED";
export type LaunchStatusValue = "DRY_RUN" | "QUEUED" | "SIMULATING" | "SIGNING" | "BROADCAST" | "CONFIRMED" | "FEE_RECIPIENT_PENDING" | "REPLIED" | "FAILED";
export type SignedTxKindValue = "CREATE_LAUNCH" | "CREATE_LAUNCH_AND_BUY" | "ERC20_APPROVE" | "SET_CREATOR_FEE_RECIPIENT" | "FEE_CLAIM";

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
  creator: { xUserId: string; xHandle: string };
  ticker: string;
  name: string;
  quoteAddress: string;
  devBuyWei: bigint | null;
  request: WebLaunchRequest;
  imageData: Uint8Array | null;
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
}

export class PrismaBotStore implements BotStore {
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
      include: { creator: { select: { xUserId: true, xHandle: true } } },
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
      },
      imageData: candidate.imageData ? new Uint8Array(candidate.imageData) : null,
    };
  }
  async recordSignedTx(rec: SignedTxRecord) {
    await db().signedTransaction.create({ data: { ...rec, txHash: rec.txHash ?? null } });
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
  private seq = 0;
  now: () => Date = () => new Date();

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
      creator: { xUserId: creator?.xUserId ?? "", xHandle: creator?.xHandle ?? "" },
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
