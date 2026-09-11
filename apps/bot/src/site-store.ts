import { getAddress } from "viem";
import { db, Prisma } from "@o1bot/db";
import type { SiteFile } from "@o1bot/sites";
import type { MemoryBotStore } from "./store";

/**
 * Persistence for token sites: the subdomain reservation, the versions the
 * agent wrote, and the jobs that produce them. Behind an interface so the
 * pipeline tests and DB-less dry runs use the in-memory version. The slug is
 * a database unique constraint, so two launches can never claim the same
 * subdomain even across workers.
 */

export type SiteStatusValue = "RESERVED" | "GENERATING" | "LIVE" | "FAILED" | "RELEASED" | "SUSPENDED";
export type SiteJobStatusValue = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export type SiteRecord = {
  id: string;
  slug: string;
  chainId: number;
  token: string | null;
  launchId: string | null;
  ownerId: string;
  status: SiteStatusValue;
  publishedN: number | null;
  error: string | null;
  createdAt: Date;
};

export type SiteVersionRecord = { id: string; siteId: string; n: number; files: SiteFile[]; summary: string | null; prompt: string | null; createdAt: Date };

export type SiteJobRecord = {
  id: string;
  siteId: string;
  instruction: string | null;
  baseN: number | null;
  mentionId: string | null;
  status: SiteJobStatusValue;
  versionN: number | null;
  error: string | null;
  createdById: string | null;
  createdAt: Date;
};

/** The launch behind a site, as much of it as the brief needs. */
export type SiteLaunchInfo = {
  launchId: string;
  name: string;
  ticker: string;
  chainId: number;
  quoteSymbol: string;
  tokenAddress: string | null;
  imageUri: string | null;
  metadataUri: string | null;
  source: "X" | "WEB";
  creator: { id: string; xUserId: string; xHandle: string };
  /** The post that launched the token, for X launches. */
  originPost: string | null;
  /** Extras the creator gave: from the parsed post (X) or the form (web). */
  extras: { description: string | null; website: string | null; telegram: string | null; xHandle: string | null };
};

export type SiteReserveInput = { slug: string; chainId: number; ownerId: string; launchId?: string | null; token?: string | null; status?: SiteStatusValue };
export type SitePatch = { status?: SiteStatusValue; token?: string | null; launchId?: string | null; error?: string | null; publishedN?: number | null };
export type NewSiteVersion = { files: SiteFile[]; brief: unknown; prompt: string | null; summary: string | null; createdById: string | null };
export type NewSiteJob = { siteId: string; instruction: string | null; baseN: number | null; mentionId: string | null; createdById: string | null };

/** Launch statuses that mean the token exists on chain. */
export const LIVE_LAUNCH_STATUSES = ["CONFIRMED", "FEE_RECIPIENT_PENDING", "REPLIED"] as const;

export interface SiteStore {
  reserve(input: SiteReserveInput): Promise<{ ok: true; site: SiteRecord } | { ok: false; reason: "taken" }>;
  /** Forget a site that never got its launch: the reservation failed or expired. */
  release(siteId: string): Promise<void>;
  update(siteId: string, patch: SitePatch): Promise<void>;
  byId(siteId: string): Promise<SiteRecord | null>;
  bySlug(slug: string): Promise<SiteRecord | null>;
  byLaunch(launchId: string): Promise<SiteRecord | null>;
  launchInfo(launchId: string): Promise<SiteLaunchInfo | null>;
  launchByToken(token: string): Promise<SiteLaunchInfo | null>;
  /** Live bot launches with this ticker, oldest first, at most a few. */
  launchesByTicker(ticker: string): Promise<SiteLaunchInfo[]>;
  addVersion(siteId: string, v: NewSiteVersion): Promise<SiteVersionRecord>;
  version(siteId: string, n: number): Promise<SiteVersionRecord | null>;
  createJob(j: NewSiteJob): Promise<SiteJobRecord>;
  /** The oldest queued job (or the one named), moved to RUNNING atomically; null when there is none. */
  claimJob(jobId?: string): Promise<SiteJobRecord | null>;
  finishJob(jobId: string, result: { versionN: number } | { error: string }): Promise<void>;
  /** Reservations older than `before` whose launch never confirmed (no token): deleted. Returns how many. */
  expireReservations(before: Date): Promise<number>;
}

type RawExtras = Record<string, unknown> | null | undefined;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function extrasFrom(parse: RawExtras, request: RawExtras): SiteLaunchInfo["extras"] {
  const p = parse ?? {};
  const r = request ?? {};
  return {
    description: str(p.description) ?? str(r.description),
    website: str(p.website) ?? str(r.website),
    telegram: str(p.telegram) ?? str(r.telegram),
    xHandle: str(p.x_handle) ?? str(r.xHandle),
  };
}

const launchInclude = { creator: { select: { id: true, xUserId: true, xHandle: true } }, mention: { select: { text: true, parse: true } } } as const;
type LaunchRow = Prisma.LaunchGetPayload<{ include: typeof launchInclude }>;

function infoFrom(l: LaunchRow): SiteLaunchInfo {
  return {
    launchId: l.id,
    name: l.name,
    ticker: l.ticker,
    chainId: l.chainId,
    quoteSymbol: l.quoteSymbol,
    tokenAddress: l.tokenAddress,
    imageUri: l.imageUri,
    metadataUri: l.metadataUri,
    source: l.source,
    creator: l.creator,
    originPost: l.mention?.text ?? null,
    extras: extrasFrom(l.mention?.parse as RawExtras, l.request as RawExtras),
  };
}

export class PrismaSiteStore implements SiteStore {
  async reserve(input: SiteReserveInput) {
    try {
      const site = await db().tokenSite.create({
        data: { slug: input.slug, chainId: input.chainId, ownerId: input.ownerId, launchId: input.launchId ?? null, token: input.token ?? null, status: input.status ?? "RESERVED" },
      });
      return { ok: true as const, site };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false as const, reason: "taken" as const };
      throw err;
    }
  }
  async release(siteId: string) {
    await db().$transaction([db().tokenSiteJob.deleteMany({ where: { siteId } }), db().tokenSiteVersion.deleteMany({ where: { siteId } }), db().tokenSite.delete({ where: { id: siteId } })]);
  }
  async update(siteId: string, patch: SitePatch) {
    await db().tokenSite.update({ where: { id: siteId }, data: patch });
  }
  byId(siteId: string) {
    return db().tokenSite.findUnique({ where: { id: siteId } });
  }
  bySlug(slug: string) {
    return db().tokenSite.findUnique({ where: { slug } });
  }
  byLaunch(launchId: string) {
    return db().tokenSite.findUnique({ where: { launchId } });
  }
  async launchInfo(launchId: string) {
    const l = await db().launch.findUnique({ where: { id: launchId }, include: launchInclude });
    return l ? infoFrom(l) : null;
  }
  async launchByToken(token: string) {
    const l = await db().launch.findFirst({ where: { tokenAddress: { equals: getAddress(token), mode: "insensitive" }, status: { in: [...LIVE_LAUNCH_STATUSES] } }, include: launchInclude, orderBy: { createdAt: "asc" } });
    return l ? infoFrom(l) : null;
  }
  async launchesByTicker(ticker: string) {
    const rows = await db().launch.findMany({ where: { ticker: { equals: ticker, mode: "insensitive" }, status: { in: [...LIVE_LAUNCH_STATUSES] } }, include: launchInclude, orderBy: { createdAt: "asc" }, take: 5 });
    return rows.map(infoFrom);
  }
  async addVersion(siteId: string, v: NewSiteVersion) {
    const max = await db().tokenSiteVersion.aggregate({ where: { siteId }, _max: { n: true } });
    const n = (max._max.n ?? 0) + 1;
    const row = await db().tokenSiteVersion.create({ data: { siteId, n, files: v.files as unknown as Prisma.InputJsonValue, brief: v.brief as Prisma.InputJsonValue, prompt: v.prompt, summary: v.summary, createdById: v.createdById } });
    return { id: row.id, siteId, n, files: v.files, summary: row.summary, prompt: row.prompt, createdAt: row.createdAt };
  }
  async version(siteId: string, n: number) {
    const row = await db().tokenSiteVersion.findUnique({ where: { siteId_n: { siteId, n } } });
    return row ? { id: row.id, siteId, n: row.n, files: row.files as SiteFile[], summary: row.summary, prompt: row.prompt, createdAt: row.createdAt } : null;
  }
  createJob(j: NewSiteJob) {
    return db().tokenSiteJob.create({ data: { siteId: j.siteId, instruction: j.instruction, baseN: j.baseN, mentionId: j.mentionId, createdById: j.createdById } });
  }
  async claimJob(jobId?: string) {
    const candidate = jobId ? await db().tokenSiteJob.findUnique({ where: { id: jobId } }) : await db().tokenSiteJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    if (!candidate || candidate.status !== "QUEUED") return null;
    const claimed = await db().tokenSiteJob.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
    return claimed.count === 1 ? { ...candidate, status: "RUNNING" as const } : null;
  }
  async finishJob(jobId: string, result: { versionN: number } | { error: string }) {
    await db().tokenSiteJob.update({ where: { id: jobId }, data: "versionN" in result ? { status: "DONE", versionN: result.versionN, finishedAt: new Date() } : { status: "FAILED", error: result.error.slice(0, 1000), finishedAt: new Date() } });
  }
  async expireReservations(before: Date) {
    const stale = await db().tokenSite.findMany({ where: { status: "RESERVED", token: null, createdAt: { lt: before } }, select: { id: true } });
    for (const s of stale) await this.release(s.id);
    return stale.length;
  }
}

/** In-memory store for tests and DB-less dry runs; launches come from the memory bot store. */
export class MemorySiteStore implements SiteStore {
  sites: SiteRecord[] = [];
  versions: Array<SiteVersionRecord & { brief: unknown; createdById: string | null }> = [];
  jobs: SiteJobRecord[] = [];
  private seq = 0;
  now: () => Date = () => new Date();

  constructor(private readonly bot: MemoryBotStore) {}

  async reserve(input: SiteReserveInput) {
    if (this.sites.some((s) => s.slug === input.slug)) return { ok: false as const, reason: "taken" as const };
    const site: SiteRecord = { id: `s${++this.seq}`, slug: input.slug, chainId: input.chainId, ownerId: input.ownerId, launchId: input.launchId ?? null, token: input.token ?? null, status: input.status ?? "RESERVED", publishedN: null, error: null, createdAt: this.now() };
    this.sites.push(site);
    return { ok: true as const, site };
  }
  async release(siteId: string) {
    this.sites = this.sites.filter((s) => s.id !== siteId);
    this.versions = this.versions.filter((v) => v.siteId !== siteId);
    this.jobs = this.jobs.filter((j) => j.siteId !== siteId);
  }
  async update(siteId: string, patch: SitePatch) {
    const s = this.sites.find((x) => x.id === siteId);
    if (s) Object.assign(s, patch);
  }
  async byId(siteId: string) {
    return this.sites.find((s) => s.id === siteId) ?? null;
  }
  async bySlug(slug: string) {
    return this.sites.find((s) => s.slug === slug) ?? null;
  }
  async byLaunch(launchId: string) {
    return this.sites.find((s) => s.launchId === launchId) ?? null;
  }
  private info(l: MemoryBotStore["launches"][number]): SiteLaunchInfo {
    const creator = this.bot.users.find((u) => u.id === l.creatorUserId);
    const mention = l.mentionId ? this.bot.mentions.find((m) => m.id === l.mentionId) : null;
    return {
      launchId: l.id,
      name: l.name,
      ticker: l.ticker,
      chainId: l.chainId,
      quoteSymbol: l.quoteSymbol,
      tokenAddress: l.tokenAddress ?? null,
      imageUri: l.imageUri ?? null,
      metadataUri: l.metadataUri ?? null,
      source: l.source,
      creator: { id: creator?.id ?? l.creatorUserId, xUserId: creator?.xUserId ?? "", xHandle: creator?.xHandle ?? "" },
      originPost: mention?.text ?? null,
      extras: extrasFrom(mention?.parse as RawExtras, l.request as RawExtras),
    };
  }
  async launchInfo(launchId: string) {
    const l = this.bot.launches.find((x) => x.id === launchId);
    return l ? this.info(l) : null;
  }
  async launchByToken(token: string) {
    const l = this.bot.launches.find((x) => x.tokenAddress?.toLowerCase() === token.toLowerCase() && (LIVE_LAUNCH_STATUSES as readonly string[]).includes(x.status));
    return l ? this.info(l) : null;
  }
  async launchesByTicker(ticker: string) {
    return this.bot.launches
      .filter((x) => x.ticker.toLowerCase() === ticker.toLowerCase() && (LIVE_LAUNCH_STATUSES as readonly string[]).includes(x.status))
      .slice(0, 5)
      .map((l) => this.info(l));
  }
  async addVersion(siteId: string, v: NewSiteVersion) {
    const n = Math.max(0, ...this.versions.filter((x) => x.siteId === siteId).map((x) => x.n)) + 1;
    const row = { id: `v${++this.seq}`, siteId, n, files: v.files, summary: v.summary, prompt: v.prompt, createdAt: this.now(), brief: v.brief, createdById: v.createdById };
    this.versions.push(row);
    return row;
  }
  async version(siteId: string, n: number) {
    return this.versions.find((v) => v.siteId === siteId && v.n === n) ?? null;
  }
  async createJob(j: NewSiteJob) {
    const job: SiteJobRecord = { id: `j${++this.seq}`, siteId: j.siteId, instruction: j.instruction, baseN: j.baseN, mentionId: j.mentionId, status: "QUEUED", versionN: null, error: null, createdById: j.createdById, createdAt: this.now() };
    this.jobs.push(job);
    return job;
  }
  async claimJob(jobId?: string) {
    const job = jobId ? this.jobs.find((j) => j.id === jobId && j.status === "QUEUED") : this.jobs.find((j) => j.status === "QUEUED");
    if (!job) return null;
    job.status = "RUNNING";
    return job;
  }
  async finishJob(jobId: string, result: { versionN: number } | { error: string }) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if ("versionN" in result) Object.assign(job, { status: "DONE", versionN: result.versionN });
    else Object.assign(job, { status: "FAILED", error: result.error });
  }
  async expireReservations(before: Date) {
    const stale = this.sites.filter((s) => s.status === "RESERVED" && s.token === null && s.createdAt < before);
    for (const s of stale) await this.release(s.id);
    return stale.length;
  }
}
