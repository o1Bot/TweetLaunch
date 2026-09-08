import { describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import type { LaunchPlan, PlanResult } from "@o1bot/executor";
import { RESERVED_HANDLES } from "@o1bot/shared";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient } from "@o1bot/x";
import type { BotConfig } from "../src/config";
import type { PipelineDeps } from "../src/pipeline";
import { MemoryBotStore, type NewLaunch } from "../src/store";
import { drainWebLaunches, processWebLaunch } from "../src/web-launches";
import { dryRunTradeChain } from "../src/trade-chain";

const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const FACTORY: Address = getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d");
const ETH = "0x0000000000000000000000000000000000000000";
const TX: Hex = `0x${"ab".repeat(32)}`;
const POOL_ID: Hex = `0x${"ef".repeat(32)}`;

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
    siteUrl: "https://o1bot.exchange",
    botHandle: "o1bot_exchange",
    botUserId: "999",
    reservedHandles: [...RESERVED_HANDLES],
    ...over,
  };
}

function fakePlan(over: { shortfallWei?: bigint } = {}): PlanResult {
  const value = parseEther("0.001");
  const plan = {
    chainId: 4663,
    factory: FACTORY,
    salt: { creatorSalt: `0x${"11".repeat(32)}`, scopedSalt: `0x${"22".repeat(32)}`, token: TOKEN, attempts: 1 },
    call: { functionName: "createLaunch", args: [{}], value },
    route: null,
    routeAttempts: [],
    simulation: { token: TOKEN, poolId: POOL_ID, amountOut: null, gas: 2_000_000n, gasSource: "fallback" },
    funding: { valueWei: value, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, gasWei: 2_000_000n, requiredWei: value, balanceWei: 0n, shortfallWei: over.shortfallWei ?? 0n },
    quote: { symbol: "ETH", address: ETH, decimals: 18, kind: "crypto" },
  } as unknown as LaunchPlan;
  return { ok: true, plan };
}

function linked(): LinkStatus {
  const user: LinkedUser = {
    privyUserId: "did:privy:alice",
    xUserId: "111",
    xHandle: "alice",
    xName: "Alice",
    xAvatarUrl: null,
    wallet: { address: ALICE_WALLET, walletId: "wallet-alice", delegated: true },
    hasLoggedIn: true,
    pregenerated: false,
  };
  return { linked: true, user, wallet: user.wallet! };
}

function harness(over: Partial<BotConfig> = {}) {
  const store = new MemoryBotStore();
  store.now = () => new Date("2026-09-08T10:00:00Z");
  const x = new FakeXClient();
  const state = { link: linked() as LinkStatus, plan: fakePlan(), executed: 0, metadataImageBytes: null as Uint8Array | null };
  const deps: PipelineDeps = {
    store,
    x,
    config: config(over),
    parse: async () => {
      throw new Error("parser is not used for web launches");
    },
    localize: async (t) => t,
    resolveLink: async () => state.link,
    ensureRecipientWallet: async () => {
      throw new Error("not used");
    },
    prepareMetadata: async (input) => {
      state.metadataImageBytes = input.imageBytes ?? null;
      return { uri: `ipfs://meta/${input.symbol}`, imageUri: `ipfs://img/${input.symbol}`, imageSource: input.imageBytes ? "tweet" : "placeholder", imageRejectReason: null, json: {}, pinnedBy: "o1bot" };
    },
    plan: async () => state.plan,
    execute: async (plan, wallet, audit) => {
      state.executed++;
      await audit({ kind: "createLaunch", chainId: 4663, wallet: wallet.address, to: plan.factory, calldataHash: `0x${"00".repeat(32)}`, valueWei: plan.call.value.toString() });
      return { txHash: TX, token: plan.salt.token, poolId: POOL_ID, blockNumber: 2n, gasUsed: 1n };
    },
    setFeeRecipient: async () => TX,
    trade: dryRunTradeChain(),
    now: () => new Date("2026-09-08T10:00:00Z"),
  };
  return { store, x, deps, state };
}

async function queueWebLaunch(store: MemoryBotStore, over: Partial<NewLaunch> = {}) {
  const user = await store.upsertUser({ xUserId: "111", xHandle: "alice", walletAddress: ALICE_WALLET, walletId: "wallet-alice", delegated: true });
  return store.createLaunch({
    mentionId: null,
    source: "WEB",
    creatorUserId: user.id,
    feeRecipientUserId: null,
    chainId: 4663,
    factory: FACTORY,
    quoteAddress: ETH,
    quoteSymbol: "ETH",
    ticker: "CASHCAT",
    name: "Cash Cat",
    devBuyWei: null,
    imageUri: null,
    metadataUri: null,
    status: "QUEUED",
    request: { devBuyNative: null, description: "The cat that pays you back.", website: "https://cashcat.xyz", telegram: null, xHandle: null, feesToHandle: null },
    imageData: new Uint8Array([1, 2, 3]),
    ...over,
  });
}

describe("web launches", () => {
  it("claims the queued row, runs the shared core and stores the outcome for the page", async () => {
    const h = harness();
    const { id } = await queueWebLaunch(h.store);
    const ran = await drainWebLaunches(h.deps);
    expect(ran).toBe(1);
    const row = h.store.launches.find((l) => l.id === id)!;
    expect(row.status).toBe("CONFIRMED");
    expect(row.tokenAddress).toBe(TOKEN);
    expect(row.launchTxHash).toBe(TX);
    expect(row.userMessage).toContain(TOKEN);
    expect(row.imageData).toBeNull();
    expect(h.state.metadataImageBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(h.state.executed).toBe(1);
    expect(h.store.signedTxs[0]).toMatchObject({ launchId: id, tweetId: `web:${id}`, xUserId: "111", kind: "CREATE_LAUNCH" });
    expect(h.x.replies).toHaveLength(0);
    expect(await h.store.claimQueuedWebLaunch()).toBeNull();
  });

  it("fails a launch whose account is no longer linked, without signing", async () => {
    const h = harness();
    h.state.link = { linked: false, reason: "not_delegated", user: null };
    await queueWebLaunch(h.store);
    await drainWebLaunches(h.deps);
    const row = h.store.launches[0]!;
    expect(row.status).toBe("FAILED");
    expect(row.userMessage).toContain("sign in with X at");
    expect(h.state.executed).toBe(0);
  });

  it("reports the shortfall with the deposit address", async () => {
    const h = harness();
    h.state.plan = fakePlan({ shortfallWei: parseEther("0.01") });
    const job = (await queueWebLaunch(h.store), await h.store.claimQueuedWebLaunch())!;
    const out = await processWebLaunch(job, h.deps);
    expect(out.outcome).toBe("rejected");
    expect(out.message).toContain("0.01 ETH short");
    expect(out.message).toContain(ALICE_WALLET);
    expect(h.state.executed).toBe(0);
  });

  it("records a dry run with the predicted token and signs nothing", async () => {
    const h = harness({ dryRun: true });
    await queueWebLaunch(h.store);
    await drainWebLaunches(h.deps);
    const row = h.store.launches[0]!;
    expect(row.status).toBe("DRY_RUN");
    expect(row.tokenAddress).toBe(TOKEN);
    expect(h.state.executed).toBe(0);
  });

  it("applies the cooldown between a launch and the next web request", async () => {
    const h = harness();
    await queueWebLaunch(h.store);
    await drainWebLaunches(h.deps);
    await queueWebLaunch(h.store);
    await drainWebLaunches(h.deps);
    const second = h.store.launches[1]!;
    expect(second.status).toBe("FAILED");
    expect(second.userMessage).toMatch(/Try again in \d+ min/);
    expect(h.state.executed).toBe(1);
  });
});
