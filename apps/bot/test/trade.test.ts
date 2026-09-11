import { dryRunBridgeChain } from "../src/bridge-chain";
import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, parseEther, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { poolIdOf } from "@o1bot/executor";
import type { ParsedMention, ParseResult, TradeCommand } from "@o1bot/parser";
import { buildAllowlist, checkTransaction, RESERVED_HANDLES } from "@o1bot/shared";
import { encodeExactInputSwap, launchPoolKey } from "@o1bot/swap";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient, type XMention } from "@o1bot/x";
import type { BotConfig } from "../src/config";
import type { O1TokenSource } from "../src/o1-tokens";
import { processMention, type PipelineDeps } from "../src/pipeline";
import { formatEthCeil } from "../src/replies";
import { MemoryAskData } from "../src/ask-data";
import { MemorySiteStore } from "../src/site-store";
import { MemoryBotStore, type TradableToken } from "../src/store";
import { SWAP_GAS, type TradeChain, type TradePlan } from "../src/trade-core";

/**
 * Trades from a post, end to end with fakes: the in-memory store seeded
 * with pools the bot launched, a fake o1 directory for everything else, a
 * scripted parser, and a fake chain that records what would be signed and
 * checks the encoded router call against the real allow-list, so the flow
 * and the guard are tested together.
 */

const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const CAT: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const CAT2: Address = getAddress("0x9093f31188C0b5DaEA6c0270bf21FBbA24D80b01");
const NVDOG: Address = getAddress("0x07BC0A5Bf7C31D9B983a7999341228EC23171401");
const NVDA: Address = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const OTHER: Address = getAddress("0x54b463e9f765c4fcb18a1be1e6b33d0f6abab401");
const HOOK: Address = getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc");
const FACTORY: Address = getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d");
const ESCROW: Address = getAddress("0xc5444b417a04a7E1B9C1E327c7D499803c14E5EF");
const ROUTER: Address = getAddress("0x3333333333333333333333333333333333333333");
const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const REFERRER: Address = getAddress("0x2222222222222222222222222222222222222222");
const CREATOR: Address = getAddress("0x4444444444444444444444444444444444444444");
const UNKNOWN_HOOK: Address = getAddress("0x5555555555555555555555555555555555555555");
const TX: Hex = `0x${"ab".repeat(32)}`;
const NOW = new Date("2026-09-09T10:00:00Z");

const mention = (text: string, id = "2000"): XMention => ({
  id,
  text,
  authorId: "111",
  authorHandle: "alice",
  authorName: "Alice",
  authorImage: null,
  imageUrl: null,
  createdAt: NOW.toISOString(),
  lang: "en",
  referenced: [],
});

const tradeCmd = (over: Partial<TradeCommand> = {}): ParseResult => ({
  kind: "trade",
  side: "buy",
  ticker: "CAT",
  tokenAddress: null,
  amount: "0.05",
  amountSymbol: null,
  sellPortion: null,
  slippageBps: null,
  fromChain: null,
  language: "en",
  reason: "test",
  ...over,
});

/** A pool whose id really is the keccak of its key, as the core verifies. */
const pool = (token: Address, symbol: string, over: Partial<TradableToken> = {}): TradableToken => {
  const quoteAddress = getAddress(over.quoteAddress ?? zeroAddress);
  const hook = getAddress(over.hook ?? HOOK);
  const tickSpacing = over.tickSpacing ?? 200;
  return {
    token,
    symbol,
    name: symbol,
    quoteAddress,
    quoteSymbol: "ETH",
    quoteDecimals: 18,
    tickSpacing,
    hook,
    poolId: poolIdOf(launchPoolKey(token, quoteAddress, tickSpacing, hook)),
    launchedAt: new Date("2026-09-07T18:00:00Z"),
    source: "bot",
    liquidityUsd: null,
    ...over,
  };
};

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
    // Several tests run more than one trade at the same fake instant; the cooldown test sets its own.
    tradeCooldownSeconds: 0,
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

type ChainState = {
  executed: TradePlan[];
  balances: { eth: bigint; token: bigint; quote: bigint };
  launchTime: number;
  initialized: boolean;
  approvals: { erc20: boolean; permit2: boolean };
  approvalsAskedFor: Address[];
  usd: Record<string, number | null>;
};

type Harness = { deps: PipelineDeps; store: MemoryBotStore; x: FakeXClient; chain: ChainState; o1: TradableToken[]; script: { parse: ParseResult } };

function harness(over: Partial<BotConfig> = {}): Harness {
  const store = new MemoryBotStore();
  store.now = () => NOW;
  store.pools.push(pool(CAT, "CAT"), pool(NVDOG, "NVDOG", { quoteAddress: NVDA, quoteSymbol: "NVDA", quoteDecimals: 18 }));
  const x = new FakeXClient();
  const chainState: ChainState = {
    executed: [],
    balances: { eth: parseEther("1"), token: parseEther("1000000"), quote: parseEther("100") },
    launchTime: 1_757_000_000,
    initialized: true,
    approvals: { erc20: true, permit2: true },
    approvalsAskedFor: [],
    usd: { [zeroAddress]: 2500, [NVDA]: 180 },
  };
  const trade: TradeChain = {
    addresses: () => ({ router: ROUTER, permit2: PERMIT2, referrer: REFERRER }),
    async poolConfig() {
      return { initialized: chainState.initialized, currentCreator: CREATOR, creatorFeeRecipient: CREATOR, baseFeeBps: 100, antiSnipeStartTotalBps: 9900, antiSnipeWindowSeconds: 20, launchTime: chainState.launchTime };
    },
    async balances(_wallet, _token, quote) {
      return { eth: chainState.balances.eth, token: chainState.balances.token, quote: quote === zeroAddress ? chainState.balances.eth : chainState.balances.quote };
    },
    async approvals(_wallet, asset) {
      chainState.approvalsAskedFor.push(asset);
      return chainState.approvals;
    },
    async quote(input) {
      const tokenSide = input.poolKey.currency0 === CAT || input.poolKey.currency0 === NVDOG || input.poolKey.currency0 === OTHER ? "c0" : "c1";
      const buying = (tokenSide === "c0") !== input.zeroForOne;
      return buying ? input.amountIn * 1000n : input.amountIn / 1000n;
    },
    async usdPrice(asset) {
      return chainState.usd[asset] ?? null;
    },
    async fees() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n };
    },
    async execute(plan, wallet, audit) {
      // The same guard the real signer applies, on the exact calldata the plan encodes.
      const allowlist = buildAllowlist({ chainId: plan.chainId, factory: FACTORY, feeEscrow: ESCROW, trade: { router: plan.router, permit2: plan.permit2, hook: plan.hook, referrer: plan.referrer, maxValueWei: plan.maxValueWei, pools: [plan.pool] } });
      const enc = encodeExactInputSwap({ router: plan.router, poolKey: plan.poolKey, zeroForOne: plan.zeroForOne, amountIn: plan.amountIn, minAmountOut: plan.minAmountOut, hookData: plan.hookData, deadline: plan.deadline });
      const check = checkTransaction(allowlist, { chainId: plan.chainId, to: enc.to, data: enc.data, value: enc.value });
      if (!check.ok) throw new Error(`allow-list refused: ${check.reason}`);
      await audit({ kind: "routerExecute", chainId: plan.chainId, wallet: wallet.address, to: enc.to, calldataHash: `0x${"00".repeat(32)}`, valueWei: enc.value.toString() });
      chainState.executed.push(plan);
      return { txHash: TX, amountOut: plan.expectedOut };
    },
  };
  const h: Harness = { store, x, chain: chainState, o1: [], script: { parse: tradeCmd() }, deps: undefined as unknown as PipelineDeps };
  const o1Tokens: O1TokenSource = {
    async search(ticker) {
      return h.o1.filter((t) => t.symbol.toLowerCase() === ticker.toLowerCase());
    },
    async byAddress(address) {
      return h.o1.find((t) => t.token.toLowerCase() === address.toLowerCase()) ?? null;
    },
  };
  h.deps = {
    store,
    x,
    config: config(over),
    parse: async (): Promise<ParsedMention> => ({ result: h.script.parse, raw: {}, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    localize: async (text) => text,
    resolveLink: async () => linked(),
    ensureRecipientWallet: async () => {
      throw new Error("not used");
    },
    prepareMetadata: async () => {
      throw new Error("not used");
    },
    plan: async () => {
      throw new Error("not used");
    },
    execute: async () => {
      throw new Error("not used");
    },
    setFeeRecipient: async () => {
      throw new Error("not used");
    },
    trade,
    o1Tokens,
    askData: new MemoryAskData(),
    sites: new MemorySiteStore(store),
    generateSite: async () => {
      throw new Error("not used");
    },
    bridge: dryRunBridgeChain(),
    relay: { quote: async () => { throw new Error("not used"); }, status: async () => ({ status: "unknown", fillTxHash: null }) },
    now: () => NOW,
  };
  return h;
}

const enableTrading = (h: Harness, maxTradeWei: bigint | null = null) => h.store.trading.set("111", { enabled: true, maxTradeWei });

describe("trades from a post", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses until the user has enabled trading on the profile", async () => {
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]!.text).toContain("/me");
    expect(h.chain.executed).toHaveLength(0);
    expect(h.store.mentions[0]!.status).toBe("REJECTED");
  });

  it("buys from the poster's own wallet, through the allow-list, and replies with the transaction and the token page", async () => {
    enableTrading(h);
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT"), h.deps);
    expect(out).toMatchObject({ outcome: "traded", txHash: TX });
    const plan = h.chain.executed[0]!;
    expect(plan.side).toBe("buy");
    expect(plan.value).toBe(parseEther("0.05"));
    expect(plan.amountIn).toBe(parseEther("0.05"));
    expect(plan.maxValueWei).toBe(parseEther("0.1"));
    expect(plan.referrer).toBe(REFERRER);
    expect(plan.approvalAsset).toBeNull();
    expect(plan.minAmountOut).toBe((plan.expectedOut * 9_700n) / 10_000n);
    const reply = h.x.replies[0]!.text;
    expect(reply).toMatch(/^Bought [\d,]+ \$CAT for 0\.05 ETH\./);
    expect(reply).toContain(`https://rh-scan.com/tx/${TX}`);
    expect(reply).toContain(`https://o1bot.exchange/token/${CAT}`);
    expect(h.store.trades[0]).toMatchObject({ side: "BUY", status: "REPLIED", txHash: TX });
    expect(h.store.signedTxs[0]).toMatchObject({ kind: "ROUTER_EXECUTE", xUserId: "111", wallet: ALICE_WALLET, valueWei: parseEther("0.05").toString() });
    expect(h.store.mentions[0]!.status).toBe("DONE");
  });

  it("sells a portion of the holding with no native value and the approvals a sell needs", async () => {
    enableTrading(h);
    h.script.parse = tradeCmd({ side: "sell", amount: null, sellPortion: { kind: "percent", value: 50 } });
    const out = await processMention(mention("@o1bot_exchange sell half of $CAT"), h.deps);
    expect(out).toMatchObject({ outcome: "traded" });
    const plan = h.chain.executed[0]!;
    expect(plan.side).toBe("sell");
    expect(plan.value).toBe(0n);
    expect(plan.amountIn).toBe(parseEther("500000"));
    expect(plan.approvalAsset).toBe(CAT);
    expect(plan.approvals).toEqual({ erc20: true, permit2: true });
    expect(h.x.replies[0]!.text).toMatch(/^Sold 500,000 \$CAT for [\d.]+ ETH\./);
  });

  it("buys a stock-paired token with the stock, capped through USD, with approvals on the stock", async () => {
    enableTrading(h);
    h.script.parse = tradeCmd({ ticker: "NVDOG", amount: "1", amountSymbol: "NVDA" });
    const out = await processMention(mention("@o1bot_exchange buy 1 NVDA of $NVDOG"), h.deps);
    expect(out).toMatchObject({ outcome: "traded" });
    const plan = h.chain.executed[0]!;
    expect(plan.value).toBe(0n);
    expect(plan.amountIn).toBe(parseUnits("1", 18));
    expect(plan.quoteSymbol).toBe("NVDA");
    expect(plan.approvalAsset).toBe(NVDA);
    expect(h.chain.approvalsAskedFor).toEqual([NVDA]);
    expect(h.x.replies[0]!.text).toMatch(/^Bought [\d,]+ \$NVDOG for 1 NVDA\./);

    // 2 NVDA at $180 is $360, above a 0.1 ETH cap at $2500 ($250).
    h.script.parse = tradeCmd({ ticker: "NVDOG", amount: "2", amountSymbol: "NVDA" });
    h.store.trades.length = 0;
    await processMention(mention("@o1bot_exchange buy 2 NVDA of $NVDOG", "2001"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("per-trade cap of 0.1 ETH");
    expect(h.chain.executed).toHaveLength(1);
  });

  it("tells the user the right asset when a stock pool is asked for in ETH, and the shortfall when the stock is missing", async () => {
    enableTrading(h);
    h.script.parse = tradeCmd({ ticker: "NVDOG", amount: "0.05", amountSymbol: null });
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $NVDOG", "2002"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain('"buy 5 NVDA of $NVDOG"');
    h.chain.balances.quote = parseUnits("0.25", 18);
    h.script.parse = tradeCmd({ ticker: "NVDOG", amount: "1", amountSymbol: "NVDA" });
    await processMention(mention("@o1bot_exchange buy 1 NVDA of $NVDOG", "2003"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("0.75 NVDA short");
    expect(h.chain.executed).toHaveLength(0);
  });

  it("trades a token the bot did not launch through o1's directory, after verifying the pool", async () => {
    enableTrading(h);
    h.o1.push(pool(OTHER, "REDCAT", { source: "o1", liquidityUsd: 5000, name: "Red Cat" }));
    h.script.parse = tradeCmd({ ticker: "REDCAT", amount: "0.01" });
    const out = await processMention(mention("@o1bot_exchange buy 0.01 ETH of $REDCAT", "2004"), h.deps);
    expect(out).toMatchObject({ outcome: "traded" });
    expect(h.chain.executed[0]!.pool.token).toBe(OTHER);

    // A pool on a hook o1 never deployed is refused even when the directory lists it.
    h.o1.length = 0;
    h.o1.push(pool(OTHER, "FAKE", { source: "o1", hook: UNKNOWN_HOOK }));
    h.script.parse = tradeCmd({ ticker: "FAKE", amount: "0.01" });
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of $FAKE", "2005"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("not an o1 Launchpad pool");
    // A pool whose id does not match its key is refused too.
    h.o1.length = 0;
    h.o1.push(pool(OTHER, "FAKE2", { source: "o1", poolId: `0x${"11".repeat(32)}` }));
    h.script.parse = tradeCmd({ ticker: "FAKE2", amount: "0.01" });
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of $FAKE2", "2006"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("not an o1 Launchpad pool");
    // And one the hook reports as not initialised.
    h.o1.length = 0;
    h.o1.push(pool(OTHER, "GHOST", { source: "o1" }));
    h.chain.initialized = false;
    h.script.parse = tradeCmd({ ticker: "GHOST", amount: "0.01" });
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of $GHOST", "2007"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("not an o1 Launchpad pool");
    expect(h.chain.executed).toHaveLength(1);
  });

  it("prefers the bot's own launch for a ticker, and asks with addresses when several tokens share one", async () => {
    enableTrading(h);
    // o1 also knows a CAT, but the bot launched exactly one: that one is used without a question.
    h.o1.push(pool(OTHER, "CAT", { source: "o1", liquidityUsd: 99999 }));
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2008"), h.deps);
    expect(h.chain.executed[0]!.pool.token).toBe(CAT);

    // Two bot launches with the same ticker: list them, most liquid first, and ask for the address.
    h.store.pools.push(pool(CAT2, "CAT", { launchedAt: new Date("2026-09-08T18:00:00Z"), liquidityUsd: 1000, name: "Cat Two" }));
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2009"), h.deps);
    const text = h.x.replies.at(-1)!.text;
    expect(text).toContain("More than one $CAT");
    expect(text.indexOf(CAT2)).toBeLessThan(text.indexOf(CAT));
    expect(text).toContain("$1,000 liquidity");
    h.store.pools.pop();

    // Several o1 tokens with the ticker: same question.
    h.o1.push(pool(CAT2, "DOG", { source: "o1" }), pool(OTHER, "DOG", { source: "o1" }));
    h.script.parse = tradeCmd({ ticker: "DOG" });
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $DOG", "2010"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("More than one $DOG");
    // An address settles it.
    h.script.parse = tradeCmd({ ticker: null, tokenAddress: OTHER.toLowerCase() });
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of 0x…", "2011"), h.deps);
    expect(h.chain.executed.at(-1)!.pool.token).toBe(OTHER);
  });

  it("refuses buys inside the anti-snipe window, an unknown ticker, and above the user's own cap", async () => {
    enableTrading(h, parseEther("0.02"));
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2012"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("per-trade cap of 0.02 ETH");
    h.store.trading.set("111", { enabled: true, maxTradeWei: parseEther("5") });
    h.script.parse = tradeCmd({ amount: "0.4" });
    await processMention(mention("@o1bot_exchange buy 0.4 ETH of $CAT", "2013"), h.deps);
    expect(h.chain.executed[0]!.maxValueWei).toBe(parseEther("0.5"));

    h.chain.launchTime = Math.floor(NOW.getTime() / 1000) - 5;
    h.script.parse = tradeCmd();
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2014"), h.deps);
    expect(h.x.replies.at(-1)!.text).toMatch(/anti-snipe .* 15 seconds/);
    h.chain.launchTime = 1_757_000_000;

    h.script.parse = tradeCmd({ ticker: "NOPE" });
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $NOPE", "2015"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("could not find $NOPE");
    expect(h.chain.executed).toHaveLength(1);
  });

  it("enforces the cooldown between trades", async () => {
    h = harness({ tradeCooldownSeconds: 30 });
    enableTrading(h);
    h.script.parse = tradeCmd({ ticker: null, tokenAddress: CAT.toLowerCase(), amount: "0.01" });
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of 0x…", "2016"), h.deps);
    expect(h.chain.executed).toHaveLength(1);
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of 0x…", "2017"), h.deps);
    expect(h.chain.executed).toHaveLength(1);
    expect(h.x.replies.at(-1)!.text).toContain("every few seconds");
  });

  it("tells the user the exact shortfall when the wallet cannot cover amount plus gas", async () => {
    enableTrading(h);
    h.chain.balances = { eth: parseEther("0.05"), token: 0n, quote: 0n };
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2018"), h.deps);
    const text = h.x.replies.at(-1)!.text;
    expect(text).toMatch(/is 0\.0\d+ ETH short/);
    expect(h.chain.executed).toHaveLength(0);
    expect(text).toContain(formatEthCeil(SWAP_GAS * 1_000_000_000n));
  });

  it("records a dry run without signing", async () => {
    h = harness({ dryRun: true });
    enableTrading(h);
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2019"), h.deps);
    expect(out).toMatchObject({ outcome: "trade_dry_run" });
    expect(h.chain.executed).toHaveLength(0);
    expect(h.store.trades[0]).toMatchObject({ status: "DRY_RUN" });
    expect(h.x.replies).toHaveLength(0);
  });

  it("never trades for a poster who is not linked", async () => {
    enableTrading(h);
    h.deps.resolveLink = async () => ({ linked: false, reason: "not_delegated", user: null });
    const out = await processMention(mention("@o1bot_exchange sell all $CAT", "2020"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "not_registered" });
    expect(h.chain.executed).toHaveLength(0);
  });
});
