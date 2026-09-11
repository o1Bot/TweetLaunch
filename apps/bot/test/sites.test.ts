import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import type { LaunchPlan, PlanResult } from "@o1bot/executor";
import type { ParsedMention, ParseResult } from "@o1bot/parser";
import { RESERVED_HANDLES } from "@o1bot/shared";
import type { GenerateInput } from "@o1bot/sites";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient, type XMention } from "@o1bot/x";
import { MemoryAskData } from "../src/ask-data";
import { dryRunBridgeChain } from "../src/bridge-chain";
import type { BotConfig } from "../src/config";
import { noO1Tokens } from "../src/o1-tokens";
import { processMention, type PipelineDeps } from "../src/pipeline";
import { buildBrief, drainSiteJobs, RESERVATION_TTL_MS, runSiteJob } from "../src/site-core";
import { MemorySiteStore } from "../src/site-store";
import { MemoryBotStore } from "../src/store";
import { dryRunTradeChain } from "../src/trade-chain";

/**
 * Token sites through the pipeline and the worker, with fakes: a launch
 * that asks for a site reserves the subdomain before signing and queues a
 * build; the worker runs the build with a fake agent, publishes and replies;
 * the site command works for the creator only. No X, no Anthropic, no chain.
 */

const NOW = new Date("2026-09-11T10:00:00Z");
const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const FACTORY: Address = getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d");
const TX: Hex = `0x${"ab".repeat(32)}`;
const POOL_ID: Hex = `0x${"ef".repeat(32)}`;
const SITE = "https://o1bot.exchange";

const post = (text: string, over: Partial<XMention> = {}): XMention => ({
  id: "7000",
  text: `@o1bot_exchange ${text}`,
  authorId: "111",
  authorHandle: "alice",
  authorName: "Alice",
  authorImage: null,
  imageUrl: null,
  createdAt: NOW.toISOString(),
  lang: "en",
  referenced: [],
  ...over,
});

const launchCmd = (over: Partial<Extract<ParseResult, { kind: "launch" }>> = {}): ParseResult => ({
  kind: "launch",
  ticker: "CAT",
  name: "Cash Cat",
  pair: "ETH",
  chain: null,
  devBuyNative: null,
  feesToHandle: null,
  imageFromTweet: false,
  description: "The cat that pays its own rent.",
  website: null,
  telegram: null,
  xHandle: null,
  siteSlug: "auto",
  language: "en",
  reason: "test",
  ...over,
});

const siteCmd = (over: Partial<Extract<ParseResult, { kind: "site" }>> = {}): ParseResult => ({ kind: "site", ticker: "CAT", tokenAddress: null, slug: null, language: "en", reason: "test", ...over });

function config(over: Partial<BotConfig> = {}): BotConfig {
  return {
    dryRun: false,
    pollMs: 0,
    cooldownSeconds: 600,
    maxLaunchesPerDay: 5,
    maxRepliesPerDay: 8,
    maxDevBuyWei: parseEther("1"),
    maxTradeWei: parseEther("0.5"),
    defaultUserTradeCapWei: parseEther("0.1"),
    tradeCooldownSeconds: 30,
    maxTradesPerDay: 20,
    tradeSlippageBps: 300,
    maxBridgeWei: parseEther("1"),
    siteUrl: SITE,
    sitesRootDomain: "o1bot.exchange",
    botHandle: "o1bot_exchange",
    botUserId: "999",
    reservedHandles: [...RESERVED_HANDLES],
    ...over,
  };
}

function linked(xUserId = "111", handle = "alice"): LinkStatus {
  const user: LinkedUser = { privyUserId: `did:privy:${handle}`, xUserId, xHandle: handle, xName: handle, xAvatarUrl: null, wallet: { address: ALICE_WALLET, walletId: `wallet-${handle}`, delegated: true }, hasLoggedIn: true, pregenerated: false };
  return { linked: true, user, wallet: user.wallet! };
}

function fakePlan(): PlanResult {
  const value = parseEther("0.001");
  const plan = {
    chainId: 4663,
    factory: FACTORY,
    blockNumber: 1n,
    blockTimestamp: 1n,
    salt: { creatorSalt: `0x${"11".repeat(32)}`, scopedSalt: `0x${"22".repeat(32)}`, token: TOKEN, attempts: 3 },
    call: { functionName: "createLaunch", args: [{}], value },
    route: null,
    routeAttempts: [],
    simulation: { token: TOKEN, poolId: POOL_ID, amountOut: null, gas: 2_000_000n, gasSource: "fallback" },
    funding: { valueWei: value, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, gasWei: 2_000_000n, requiredWei: value + 2_000_000n, balanceWei: 0n, shortfallWei: 0n },
    quote: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, kind: "crypto" },
  } as unknown as LaunchPlan;
  return { ok: true, plan };
}

type Harness = {
  deps: PipelineDeps;
  store: MemoryBotStore;
  sites: MemorySiteStore;
  x: FakeXClient;
  metadata: Array<{ website?: string | null }>;
  generated: GenerateInput[];
  script: { parse: ParseResult; plan: PlanResult; link: LinkStatus; executeFails: boolean; generateFails: boolean };
};

function harness(over: Partial<BotConfig> = {}): Harness {
  const store = new MemoryBotStore();
  const sites = new MemorySiteStore(store);
  sites.now = () => NOW;
  const x = new FakeXClient();
  const h: Harness = { store, sites, x, metadata: [], generated: [], script: { parse: launchCmd(), plan: fakePlan(), link: linked(), executeFails: false, generateFails: false }, deps: undefined as unknown as PipelineDeps };
  h.deps = {
    store,
    x,
    config: config(over),
    parse: async (): Promise<ParsedMention> => ({ result: h.script.parse, raw: { description: "The cat that pays its own rent.", website: null, telegram: "https://t.me/cashcat", x_handle: null }, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    localize: async (text) => text,
    resolveLink: async () => h.script.link,
    ensureRecipientWallet: async () => {
      throw new Error("not used");
    },
    prepareMetadata: async (input) => {
      h.metadata.push({ website: input.website });
      return { uri: `ipfs://meta/${input.symbol}`, imageUri: `ipfs://img/${input.symbol}`, imageSource: "placeholder", imageRejectReason: null, json: {}, pinnedBy: "o1bot" };
    },
    plan: async () => h.script.plan,
    execute: async (plan, wallet, audit) => {
      if (h.script.executeFails) throw new Error("boom");
      await audit({ kind: "createLaunch", chainId: 4663, wallet: wallet.address, to: plan.factory, calldataHash: `0x${"00".repeat(32)}`, valueWei: plan.call.value.toString() });
      return { txHash: TX, token: plan.salt.token, poolId: POOL_ID, blockNumber: 2n, gasUsed: 1_900_000n };
    },
    setFeeRecipient: async () => TX,
    trade: dryRunTradeChain(),
    o1Tokens: noO1Tokens,
    bridge: dryRunBridgeChain(),
    relay: { quote: async () => { throw new Error("not used"); }, status: async () => ({ status: "unknown", fillTxHash: null }) },
    askData: new MemoryAskData(),
    sites,
    generateSite: async (input) => {
      h.generated.push(input);
      if (h.script.generateFails) throw new Error("the model is down");
      const revision = input.instruction ? ` (${input.instruction})` : "";
      return { html: `<h1>${input.brief.name}${revision}</h1><o1bot-stats></o1bot-stats>`, css: ":root{--o1bot-accent:#f4c430}", title: `${input.brief.name} ($${input.brief.symbol})`, description: "A cat.", summary: input.instruction ? "Revised." : "Built." };
    },
    fetchImpl: (async () => new Response("not an image", { status: 404 })) as unknown as typeof fetch,
    now: () => NOW,
  } as PipelineDeps;
  return h;
}

describe("a launch that asks for a site", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("reserves the subdomain before signing, points the metadata at it and queues the build", async () => {
    const out = await processMention(post('launch $CAT "Cash Cat" pair ETH site'), h.deps);
    expect(out.outcome).toBe("launched");
    expect(h.sites.sites).toHaveLength(1);
    expect(h.sites.sites[0]).toMatchObject({ slug: "cat", status: "RESERVED", token: TOKEN, chainId: 4663 });
    expect(h.sites.sites[0]?.launchId).toBe(h.store.launches[0]?.id);
    expect(h.metadata[0]?.website).toBe("https://cat.o1bot.exchange");
    expect(h.sites.jobs).toHaveLength(1);
    expect(h.sites.jobs[0]).toMatchObject({ status: "QUEUED", instruction: null, mentionId: h.store.mentions[0]?.id });
    expect(h.x.replies[0]?.text).toContain("https://cat.o1bot.exchange");
  });

  it("uses the name the creator chose and keeps a website they gave", async () => {
    h.script.parse = launchCmd({ siteSlug: "catcoin", website: "https://cashcat.xyz" });
    await processMention(post("launch"), h.deps);
    expect(h.sites.sites[0]?.slug).toBe("catcoin");
    expect(h.metadata[0]?.website).toBe("https://cashcat.xyz");
  });

  it("refuses a taken or impossible name before anything is signed", async () => {
    await h.sites.reserve({ slug: "cat", chainId: 4663, ownerId: "someone" });
    let out = await processMention(post("launch"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("cat.o1bot.exchange is already taken");
    expect(h.store.launches).toHaveLength(0);

    h.script.parse = launchCmd({ siteSlug: "www" });
    out = await processMention(post("launch", { id: "7001" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[1]?.text).toContain("cannot be a site name");
    expect(h.sites.sites).toHaveLength(1);
  });

  it("frees the subdomain when the launch fails or is a dry run", async () => {
    h.script.executeFails = true;
    await processMention(post("launch"), h.deps);
    expect(h.sites.sites).toHaveLength(0);
    expect(h.sites.jobs).toHaveLength(0);

    h = harness({ dryRun: true });
    await processMention(post("launch"), h.deps);
    expect(h.sites.sites).toHaveLength(0);
  });

  it("launches without a site when none was asked for", async () => {
    h.script.parse = launchCmd({ siteSlug: null });
    await processMention(post("launch"), h.deps);
    expect(h.sites.sites).toHaveLength(0);
    expect(h.metadata[0]?.website).toBeNull();
    expect(h.x.replies[0]?.text).not.toContain("o1bot.exchange;");
  });
});

describe("the worker", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await processMention(post('launch $CAT "Cash Cat" pair ETH site'), h.deps);
  });

  it("briefs the agent from the launch, publishes the first build and replies under the post", async () => {
    const ran = await drainSiteJobs(h.deps);
    expect(ran).toBe(1);
    const brief = h.generated[0]?.brief;
    expect(brief).toMatchObject({ slug: "cat", rootDomain: "o1bot.exchange", apiOrigin: SITE, name: "Cash Cat", symbol: "CAT", chain: "robinhood", pairSymbol: "ETH", tokenAddress: TOKEN, description: "The cat that pays its own rent.", creatorHandle: "alice", language: "en" });
    expect(brief?.originPost).toContain('launch $CAT "Cash Cat" pair ETH site');
    expect(brief?.socials).toEqual({ x: "https://x.com/alice", telegram: "https://t.me/cashcat", website: null });
    expect(brief?.logoUrl).toBe("https://gateway.pinata.cloud/ipfs/img/CAT");
    expect(h.generated[0]?.current).toBeNull();
    expect(h.sites.sites[0]).toMatchObject({ status: "LIVE", publishedN: 1 });
    expect(h.sites.versions[0]?.files.map((f) => f.path)).toEqual(["index.html", "styles.css"]);
    expect(h.sites.jobs[0]).toMatchObject({ status: "DONE", versionN: 1 });
    expect(h.x.replies).toHaveLength(2);
    expect(h.x.replies[1]?.inReplyTo).toBe("7000");
    expect(h.x.replies[1]?.text).toContain("https://cat.o1bot.exchange");
    expect(h.x.replies[1]?.text).toContain(`${SITE}/site/cat`);
  });

  it("stores a revision without publishing it, starting from the published version", async () => {
    await drainSiteJobs(h.deps);
    const site = h.sites.sites[0]!;
    const job = await h.sites.createJob({ siteId: site.id, instruction: "Make the hero red", baseN: null, mentionId: null, createdById: site.ownerId });
    await runSiteJob((await h.sites.claimJob(job.id))!, h.deps, { info() {}, warn() {}, error() {} });
    expect(h.generated[1]?.current?.html).toContain("<h1>Cash Cat</h1>");
    expect(h.generated[1]?.instruction).toBe("Make the hero red");
    expect(h.sites.versions).toHaveLength(2);
    expect(h.sites.sites[0]).toMatchObject({ status: "LIVE", publishedN: 1 });
    expect(h.sites.jobs[1]).toMatchObject({ status: "DONE", versionN: 2 });
    expect(h.x.replies).toHaveLength(2);
  });

  it("marks a site that never built as failed, tells the poster, and lets it be retried", async () => {
    h.script.generateFails = true;
    await drainSiteJobs(h.deps);
    expect(h.sites.sites[0]).toMatchObject({ status: "FAILED" });
    expect(h.sites.jobs[0]).toMatchObject({ status: "FAILED", error: "the model is down" });
    expect(h.x.replies[1]?.text).toContain("could not be built");

    h.script.generateFails = false;
    h.script.parse = siteCmd();
    const out = await processMention(post("build a site for $CAT", { id: "7002" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "site" });
    expect(h.sites.sites).toHaveLength(1);
    expect(h.sites.jobs).toHaveLength(2);
    await drainSiteJobs(h.deps);
    expect(h.sites.sites[0]).toMatchObject({ status: "LIVE", publishedN: 1 });
  });

  it("respects the poster's reply cap when announcing", async () => {
    h = harness({ maxRepliesPerDay: 1 });
    await processMention(post('launch $CAT "Cash Cat" pair ETH site'), h.deps);
    await drainSiteJobs(h.deps);
    expect(h.sites.sites[0]?.status).toBe("LIVE");
    expect(h.x.replies).toHaveLength(1);
  });

  it("expires reservations that never got their launch, never one whose token exists", async () => {
    await h.sites.reserve({ slug: "old", chainId: 4663, ownerId: "u1" });
    const stale = new Date(NOW.getTime() - RESERVATION_TTL_MS - 1);
    // "cat" is old too, but its launch confirmed (token set) and its build is merely queued.
    for (const s of h.sites.sites) s.createdAt = stale;
    expect(await h.sites.expireReservations(new Date(NOW.getTime() - RESERVATION_TTL_MS))).toBe(1);
    expect(h.sites.sites.map((s) => s.slug)).toEqual(["cat"]);
  });
});

describe("the site command", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    h.script.parse = launchCmd({ siteSlug: null });
    await processMention(post('launch $CAT "Cash Cat" pair ETH'), h.deps);
    h.script.parse = siteCmd();
  });

  it("queues a build for the creator's live token and replies with the address", async () => {
    const out = await processMention(post("build a site for $CAT", { id: "7001" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "site" });
    expect(h.sites.sites[0]).toMatchObject({ slug: "cat", status: "GENERATING", token: TOKEN, launchId: h.store.launches[0]?.id });
    expect(h.sites.jobs[0]).toMatchObject({ status: "QUEUED", mentionId: h.store.mentions[1]?.id });
    expect(h.x.replies[1]?.text).toContain("being built at https://cat.o1bot.exchange");
    await drainSiteJobs(h.deps);
    expect(h.sites.sites[0]?.status).toBe("LIVE");
    expect(h.x.replies[2]?.text).toContain("Your site is live: https://cat.o1bot.exchange");
  });

  it("takes a chosen name and finds the token by address", async () => {
    h.script.parse = siteCmd({ ticker: null, tokenAddress: TOKEN.toLowerCase(), slug: "catcoin" });
    await processMention(post(`site catcoin for ${TOKEN}`, { id: "7001" }), h.deps);
    expect(h.sites.sites[0]?.slug).toBe("catcoin");
  });

  it("refuses posters who are not the creator, unknown tokens and unlinked accounts", async () => {
    let out = await processMention(post("build a site for $CAT", { id: "7001", authorId: "222", authorHandle: "bob" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[1]?.text).toContain("Only the creator of $CAT");

    h.script.parse = siteCmd({ ticker: "DOG" });
    out = await processMention(post("build a site for $DOG", { id: "7002" }), h.deps);
    expect(h.x.replies[2]?.text).toContain("could not find $DOG");

    h.script.link = { linked: false, reason: "no_account", user: null };
    out = await processMention(post("build a site for $CAT", { id: "7003" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "not_registered" });
    expect(h.sites.sites).toHaveLength(0);
  });

  it("keeps a suspended site down: no rebuild from a post, no job", async () => {
    await processMention(post("build a site for $CAT", { id: "7001" }), h.deps);
    await drainSiteJobs(h.deps);
    h.sites.sites[0]!.status = "SUSPENDED";
    const out = await processMention(post("build a site for $CAT", { id: "7002" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[3]?.text).toContain("was taken down");
    const job = await h.sites.createJob({ siteId: h.sites.sites[0]!.id, instruction: "try", baseN: null, mentionId: null, createdById: "u" });
    const result = await runSiteJob((await h.sites.claimJob(job.id))!, h.deps, { info() {}, warn() {}, error() {} });
    expect(result).toMatchObject({ ok: false, error: "site suspended" });
    expect(h.sites.versions).toHaveLength(1);
  });

  it("points at an existing live site instead of building another", async () => {
    await processMention(post("build a site for $CAT", { id: "7001" }), h.deps);
    await drainSiteJobs(h.deps);
    const out = await processMention(post("build a site for $CAT", { id: "7002" }), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "site" });
    expect(h.x.replies[3]?.text).toContain("$CAT already has a site: https://cat.o1bot.exchange");
    expect(h.sites.jobs).toHaveLength(1);
  });
});

describe("buildBrief", () => {
  it("reads the logo palette when the image can be fetched, and lives without it", async () => {
    const h = harness();
    h.script.parse = launchCmd({ siteSlug: null });
    await processMention(post("launch"), h.deps);
    const info = (await h.sites.launchInfo(h.store.launches[0]!.id))!;
    const site = { id: "s", slug: "cat", chainId: 4663, token: TOKEN, launchId: info.launchId, ownerId: info.creator.id, status: "GENERATING" as const, publishedN: null, error: null, createdAt: NOW };
    const brief = await buildBrief(site, info, "id", h.deps);
    expect(brief.palette).toBeNull();
    expect(brief.language).toBe("id");
    expect(brief.rootDomain).toBe("o1bot.exchange");
  });
});
