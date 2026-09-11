import { dryRunBridgeChain } from "../src/bridge-chain";
import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import type { LaunchPlan, PlanResult } from "@o1bot/executor";
import type { ParsedMention, ParseResult } from "@o1bot/parser";
import { activeFactory, RESERVED_HANDLES, resetEnvCache } from "@o1bot/shared";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient, XPostError, type XMention } from "@o1bot/x";
import type { BotConfig } from "../src/config";
import type { WalletRef } from "../src/execute";
import { processMention, type PipelineDeps } from "../src/pipeline";
import { MemoryAskData } from "../src/ask-data";
import { MemorySiteStore } from "../src/site-store";
import { MemoryBotStore } from "../src/store";
import { noO1Tokens } from "../src/o1-tokens";
import { dryRunTradeChain } from "../src/trade-chain";

/**
 * The whole pipeline with fakes: no X, no Anthropic, no Privy, no chain.
 * `parse` and `plan` are scripted per test; the store, queue-facing store
 * calls and the X client are the in-memory implementations shipped with the
 * packages, so what is asserted here is the real control flow.
 */

const ALICE: XMention = {
  id: "1000",
  text: '@o1bot_exchange launch $CASHCAT "Cash Cat" pair ETH',
  authorId: "111",
  authorHandle: "alice",
  authorName: "Alice",
  authorImage: null,
  imageUrl: null,
  createdAt: "2026-09-07T10:00:00.000Z",
  lang: "en",
  referenced: [],
};
const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const BOB_WALLET: Address = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const FACTORY: Address = getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d");
const TX: Hex = `0x${"ab".repeat(32)}`;
const FEE_TX: Hex = `0x${"cd".repeat(32)}`;
const POOL_ID: Hex = `0x${"ef".repeat(32)}`;

const launchCmd = (over: Partial<Extract<ParseResult, { kind: "launch" }>> = {}): ParseResult => ({
  kind: "launch",
  ticker: "CASHCAT",
  name: "Cash Cat",
  pair: "ETH",
  chain: null,
  devBuyNative: null,
  feesToHandle: null,
  imageFromTweet: false,
  description: null,
  website: null,
  telegram: null,
  xHandle: null,
  siteSlug: null,
  language: "en",
  reason: "test",
  ...over,
});

function config(over: Partial<BotConfig> = {}): BotConfig {
  return {
    dryRun: false,
    pollMs: 0,
    cooldownSeconds: 600,
    maxLaunchesPerDay: 5,
    maxRepliesPerDay: 8,
    maxDevBuyWei: parseEther("1"),
    maxDevBuyArcWei: parseEther("200"),
    maxTradeWei: parseEther("0.5"),
    defaultUserTradeCapWei: parseEther("0.1"),
    tradeCooldownSeconds: 30,
    maxTradesPerDay: 20,
    tradeSlippageBps: 300,
    maxBridgeWei: parseEther("1"),
    siteUrl: "https://o1bot.exchange",
    botHandle: "o1bot_exchange",
    botUserId: "999",
    sitesRootDomain: "o1bot.exchange",
    reservedHandles: [...RESERVED_HANDLES],
    ...over,
  };
}

function fakePlan(over: { shortfallWei?: bigint; devBuy?: bigint } = {}): PlanResult {
  const value = parseEther("0.001") + (over.devBuy ?? 0n);
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
    funding: { valueWei: value, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, gasWei: 2_000_000n, requiredWei: value + 2_000_000n, balanceWei: 0n, shortfallWei: over.shortfallWei ?? 0n },
    quote: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, kind: "crypto" },
  } as unknown as LaunchPlan;
  return { ok: true, plan };
}

type Harness = {
  deps: PipelineDeps;
  store: MemoryBotStore;
  x: FakeXClient;
  parseCalls: number;
  executeCalls: Array<{ wallet: WalletRef }>;
  feeCalls: Array<{ token: Address; recipient: Address }>;
  script: { parse: ParseResult; plan: PlanResult; link: LinkStatus };
};

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

function harness(over: Partial<BotConfig> = {}): Harness {
  const store = new MemoryBotStore();
  const x = new FakeXClient();
  const h: Harness = {
    store,
    x,
    parseCalls: 0,
    executeCalls: [],
    feeCalls: [],
    script: { parse: launchCmd(), plan: fakePlan(), link: linked() },
    deps: undefined as unknown as PipelineDeps,
  };
  h.deps = {
    store,
    x,
    config: config(over),
    parse: async (): Promise<ParsedMention> => {
      h.parseCalls++;
      return { result: h.script.parse, raw: { scripted: true }, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    },
    localize: async (text) => text,
    resolveLink: async () => h.script.link,
    ensureRecipientWallet: async (input) => ({
      privyUserId: `did:privy:${input.username}`,
      xUserId: input.xUserId,
      xHandle: input.username,
      xName: input.name ?? null,
      xAvatarUrl: null,
      wallet: { address: BOB_WALLET, walletId: null, delegated: false },
      hasLoggedIn: false,
      pregenerated: true,
    }),
    prepareMetadata: async (input) => ({ uri: `ipfs://meta/${input.symbol}`, imageUri: `ipfs://img/${input.symbol}`, imageSource: "placeholder", imageRejectReason: null, json: {}, pinnedBy: "o1bot" }),
    plan: async () => h.script.plan,
    execute: async (plan, wallet, audit) => {
      h.executeCalls.push({ wallet });
      await audit({ kind: "createLaunch", chainId: 4663, wallet: wallet.address, to: plan.factory, calldataHash: `0x${"00".repeat(32)}`, valueWei: plan.call.value.toString() });
      return { txHash: TX, token: plan.salt.token, poolId: POOL_ID, blockNumber: 2n, gasUsed: 1_900_000n };
    },
    setFeeRecipient: async (input, wallet, audit) => {
      h.feeCalls.push({ token: input.token, recipient: input.recipient });
      await audit({ kind: "setCreatorFeeRecipient", chainId: 4663, wallet: wallet.address, to: input.factory, calldataHash: `0x${"01".repeat(32)}`, valueWei: "0" });
      return FEE_TX;
    },
    trade: dryRunTradeChain(),
    o1Tokens: noO1Tokens,
    askData: new MemoryAskData(),
    sites: new MemorySiteStore(store),
    generateSite: async () => {
      throw new Error("not used");
    },
    bridge: dryRunBridgeChain(),
    relay: { quote: async () => { throw new Error("not used"); }, status: async () => ({ status: "unknown", fillTxHash: null }) },
    now: () => new Date("2026-09-07T10:00:00Z"),
  };
  return h;
}

describe("processMention", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("launches, audits the signature, replies with the token and marks everything done", async () => {
    const out = await processMention(ALICE, h.deps);
    expect(out.outcome).toBe("launched");
    if (out.outcome !== "launched") return;
    expect(out.token).toBe(TOKEN);
    expect(out.txHash).toBe(TX);
    expect(h.executeCalls[0]?.wallet).toEqual({ walletId: "wallet-alice", address: ALICE_WALLET });
    expect(h.x.replies).toHaveLength(1);
    expect(h.x.replies[0]?.inReplyTo).toBe("1000");
    expect(h.x.replies[0]?.text).toContain(TOKEN);
    expect(h.x.replies[0]?.text).toContain("$CASHCAT");
    expect(h.store.launches[0]?.status).toBe("REPLIED");
    expect(h.store.launches[0]?.launchTxHash).toBe(TX);
    expect(h.store.mentions[0]?.status).toBe("DONE");
    expect(h.store.mentions[0]?.replyTweetId).toBe("reply-1");
    expect(h.store.signedTxs).toHaveLength(1);
    expect(h.store.signedTxs[0]).toMatchObject({ tweetId: "1000", xUserId: "111", wallet: ALICE_WALLET, kind: "CREATE_LAUNCH" });
  });

  it("processes a tweet only once", async () => {
    await processMention(ALICE, h.deps);
    const again = await processMention(ALICE, h.deps);
    expect(again).toEqual({ outcome: "duplicate" });
    expect(h.parseCalls).toBe(1);
    expect(h.executeCalls).toHaveLength(1);
  });

  it("points unregistered posters at the site without parsing anything on chain", async () => {
    h.script.link = { linked: false, reason: "no_account", user: null };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "not_registered" });
    expect(h.x.replies[0]?.text).toContain("https://o1bot.exchange");
    expect(h.store.mentions[0]?.status).toBe("NOT_REGISTERED");
    expect(h.store.launches).toHaveLength(0);
  });

  it("answers clarify questions verbatim and does not launch", async () => {
    h.script.parse = { kind: "clarify", question: "Which pair? ETH, USDG or a stock token.", missing: ["pair"], language: "en", reason: "no pair" };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "clarify" });
    expect(h.x.replies[0]?.text).toBe("Which pair? ETH, USDG or a stock token.");
    expect(h.store.mentions[0]?.status).toBe("CLARIFY");
    expect(h.executeCalls).toHaveLength(0);
  });

  it("rejects other chains", async () => {
    h.script.parse = { kind: "unsupported_chain", chain: "other", language: "en", reason: "asked for solana" };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "unsupported_chain" });
    expect(h.x.replies[0]?.text).toContain("Robinhood");
    expect(h.x.replies[0]?.text).toContain("Base");
  });

  it("launches on Arc when the post says so: Arc factory, chain id 5042, USDC pair, dev buy capped in USDC", async () => {
    process.env.RPC_ARC = "https://arc.example.invalid";
    resetEnvCache();
    h.script.parse = launchCmd({ chain: "arc", pair: "USDC", devBuyNative: "5" });
    let planned: { chain?: string; devBuyWei?: bigint } | null = null;
    const arcPlan = fakePlan();
    if (arcPlan.ok) arcPlan.plan.chainId = 5042;
    h.deps.plan = async (req) => {
      planned = req;
      return arcPlan;
    };
    const out = await processMention(ALICE, h.deps);
    expect(out.outcome).toBe("launched");
    expect(planned).toMatchObject({ chain: "arc", devBuyWei: 5_000_000_000_000_000_000n });
    expect(h.store.launches[0]).toMatchObject({ chainId: 5042, factory: activeFactory("arc"), quoteSymbol: "USDC" });
    expect(h.x.replies[0]?.text).toContain("Arc");
    expect(h.x.replies[0]?.text).toContain("5 USDC");
    expect(h.x.replies[0]?.text).not.toContain("ETH");
  });

  it("refuses an Arc launch while the deployment has no Arc RPC, and caps Arc dev buys in USDC", async () => {
    delete process.env.RPC_ARC;
    resetEnvCache();
    h.script.parse = launchCmd({ chain: "arc", pair: "USDC" });
    const closed = await processMention(ALICE, h.deps);
    expect(closed).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("Arc are not open yet");

    process.env.RPC_ARC = "https://arc.example.invalid";
    resetEnvCache();
    h.script.parse = launchCmd({ chain: "arc", pair: "USDC", devBuyNative: "250" });
    const capped = await processMention({ ...ALICE, id: "m-arc-cap" }, h.deps);
    expect(capped).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[1]?.text).toContain("capped at 200 USDC");
    delete process.env.RPC_ARC;
    resetEnvCache();
  });

  it("launches on Base when the post says so: Base factory, chain id 8453, plan and links for Base", async () => {
    h.script.parse = launchCmd({ chain: "base" });
    let planned: { chain?: string } | null = null;
    const basePlan = fakePlan();
    if (basePlan.ok) basePlan.plan.chainId = 8453;
    h.deps.plan = async (req) => {
      planned = req;
      return basePlan;
    };
    const out = await processMention(ALICE, h.deps);
    expect(out.outcome).toBe("launched");
    expect(planned).toMatchObject({ chain: "base" });
    expect(h.store.launches[0]).toMatchObject({ chainId: 8453, factory: activeFactory("base"), quoteSymbol: "ETH" });
    expect(h.x.replies[0]?.text).toContain("Base");
    expect(h.x.replies[0]?.text).toContain("https://o1bot.exchange/token/");
  });

  it("stays silent on ignore", async () => {
    h.script.parse = { kind: "ignore", language: "en", reason: "unrelated" };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "ignored" });
    expect(h.x.replies).toHaveLength(0);
  });

  it("enforces the cooldown between two launches by the same account", async () => {
    await processMention(ALICE, h.deps);
    const second = await processMention({ ...ALICE, id: "1001" }, h.deps);
    expect(second).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[1]?.text).toMatch(/Try again in \d+ min/);
    expect(h.executeCalls).toHaveLength(1);
  });

  it("rejects a dev buy above the cap before touching the chain", async () => {
    h.script.parse = launchCmd({ devBuyNative: "2" });
    let planned = false;
    h.deps.plan = async () => {
      planned = true;
      return fakePlan();
    };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("capped at 1 ETH");
    expect(planned).toBe(false);
  });

  it("rejects an unknown pair and a stock-symbol ticker", async () => {
    h.script.parse = launchCmd({ pair: "DOGE" });
    expect(await processMention(ALICE, h.deps)).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("DOGE is not a pair");

    h.script.parse = launchCmd({ ticker: "NVDA" });
    expect(await processMention({ ...ALICE, id: "1001" }, h.deps)).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[1]?.text).toContain("$NVDA is a stock token symbol");
  });

  it("refuses fees to the bot's own account", async () => {
    h.script.parse = launchCmd({ feesToHandle: "o1bot_exchange" });
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("cannot receive creator fees");
  });

  it("resolves fees to @bob through X, pregenerates a wallet and sets the recipient after the launch", async () => {
    h.x.users.set("bob", { id: "222", username: "bob", name: "Bob", profileImageUrl: null });
    h.script.parse = launchCmd({ feesToHandle: "@bob" });
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "launched", feeRecipientTxHash: FEE_TX });
    expect(h.feeCalls).toEqual([{ token: TOKEN, recipient: BOB_WALLET }]);
    expect(h.x.replies[0]?.text).toContain("@bob");
    const bob = h.store.users.find((u) => u.xUserId === "222");
    expect(bob).toMatchObject({ xHandle: "bob", walletAddress: BOB_WALLET, pregenerated: true });
    expect(h.store.launches[0]).toMatchObject({ status: "REPLIED", feeRecipientUserId: bob?.id, feeRecipientTxHash: FEE_TX });
    expect(h.store.signedTxs.map((t) => t.kind)).toEqual(["CREATE_LAUNCH", "SET_CREATOR_FEE_RECIPIENT"]);
  });

  it("tells the user when the fees-to handle does not exist", async () => {
    h.script.parse = launchCmd({ feesToHandle: "@nobody" });
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("could not find @nobody");
    expect(h.executeCalls).toHaveLength(0);
  });

  it("reports the exact shortfall with the deposit address and never signs", async () => {
    h.script.plan = fakePlan({ shortfallWei: 1_234_000_000_000_000n });
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).toContain("0.0013 ETH short");
    expect(h.x.replies[0]?.text).toContain(ALICE_WALLET);
    expect(h.executeCalls).toHaveLength(0);
    expect(h.store.launches[0]?.status).toBe("FAILED");
  });

  it("falls back to the address-free reply when X blocks crypto addresses", async () => {
    h.script.plan = fakePlan({ shortfallWei: parseEther("0.01") });
    let calls = 0;
    h.x.postReply = async (text, inReplyTo) => {
      calls++;
      if (calls === 1) throw new XPostError("HTTP 403", 403, '{"detail":"Crypto addresses are prohibited"}');
      h.x.replies.push({ text, inReplyTo });
      return "reply-safe";
    };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]?.text).not.toContain(ALICE_WALLET);
    expect(h.x.replies[0]?.text).toContain("Sign in at https://o1bot.exchange");
    expect(h.store.mentions[0]?.replyTweetId).toBe("reply-safe");
  });

  it("maps a plan failure with no dev-buy route to a specific reply", async () => {
    h.script.plan = { ok: false, stage: "route", error: { kind: "dev_buy_no_route", message: "no route" } };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "failed" });
    expect(h.x.replies[0]?.text).toContain("no liquid route from ETH to ETH");
    expect(h.store.mentions[0]?.status).toBe("REJECTED");
    expect(h.store.launches[0]?.status).toBe("FAILED");
  });

  it("does not count a failed launch against the cooldown", async () => {
    h.script.plan = { ok: false, stage: "state", error: { kind: "rpc_error", message: "timeout" } };
    await processMention(ALICE, h.deps);
    h.script.plan = fakePlan();
    const second = await processMention({ ...ALICE, id: "1001" }, h.deps);
    expect(second.outcome).toBe("launched");
  });

  it("dry run records the predicted token and posts nothing", async () => {
    h = harness({ dryRun: true });
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "dry_run", token: TOKEN });
    if (out.outcome === "dry_run") expect(out.reply).toContain(TOKEN);
    expect(h.x.replies).toHaveLength(0);
    expect(h.executeCalls).toHaveLength(0);
    expect(h.store.launches[0]).toMatchObject({ status: "DRY_RUN", tokenAddress: TOKEN });
    expect(h.store.mentions[0]?.status).toBe("DONE");
  });

  it("stops replying to an account past the daily reply cap", async () => {
    h = harness({ maxRepliesPerDay: 1 });
    h.script.parse = { kind: "help", reply: "Post: launch $TICKER \"Name\" pair ETH", language: "en", reason: "help" };
    await processMention(ALICE, h.deps);
    await processMention({ ...ALICE, id: "1001" }, h.deps);
    expect(h.x.replies).toHaveLength(1);
    expect(h.store.mentions[1]?.error).toBe("reply cap reached");
  });

  it("keeps the launch confirmed when the success reply cannot be posted", async () => {
    h.x.postReply = async () => {
      throw new XPostError("HTTP 500", 500, "boom");
    };
    const out = await processMention(ALICE, h.deps);
    expect(out).toMatchObject({ outcome: "launched", reply: null });
    expect(h.store.launches[0]?.status).toBe("CONFIRMED");
    expect(h.store.mentions[0]?.status).toBe("FAILED");
    expect(h.store.mentions[0]?.error).toContain("reply failed");
  });
});
