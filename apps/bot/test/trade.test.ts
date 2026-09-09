import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";
import type { ParsedMention, ParseResult, TradeCommand } from "@o1bot/parser";
import { buildAllowlist, checkTransaction, RESERVED_HANDLES } from "@o1bot/shared";
import { encodeExactInputSwap } from "@o1bot/swap";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient, type XMention } from "@o1bot/x";
import type { BotConfig } from "../src/config";
import { processMention, type PipelineDeps } from "../src/pipeline";
import { formatEthCeil } from "../src/replies";
import { MemoryBotStore, type TradableToken } from "../src/store";
import { SWAP_GAS, type TradeChain, type TradePlan } from "../src/trade-core";

/**
 * Trades from a post, end to end with fakes: the in-memory store seeded
 * with pools the bot launched, a scripted parser, and a fake chain that
 * records what would be signed and checks the encoded router call against
 * the real allow-list, so the flow and the guard are tested together.
 */

const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const CAT: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const CAT2: Address = getAddress("0x9093f31188C0b5DaEA6c0270bf21FBbA24D80b01");
const NVDOG: Address = getAddress("0x07BC0A5Bf7C31D9B983a7999341228EC23171401");
const NVDA: Address = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const HOOK: Address = getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc");
const FACTORY: Address = getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d");
const ESCROW: Address = getAddress("0xc5444b417a04a7E1B9C1E327c7D499803c14E5EF");
const ROUTER: Address = getAddress("0x3333333333333333333333333333333333333333");
const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const REFERRER: Address = getAddress("0x2222222222222222222222222222222222222222");
const CREATOR: Address = getAddress("0x4444444444444444444444444444444444444444");
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
  amountEth: "0.05",
  sellPortion: null,
  slippageBps: null,
  language: "en",
  reason: "test",
  ...over,
});

const pool = (token: Address, symbol: string, over: Partial<TradableToken> = {}): TradableToken => ({
  token,
  symbol,
  name: symbol,
  quoteAddress: zeroAddress,
  quoteSymbol: "ETH",
  tickSpacing: 200,
  hook: HOOK,
  poolId: `0x${"ef".repeat(32)}`,
  launchedAt: new Date("2026-09-07T18:00:00Z"),
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

type Harness = {
  deps: PipelineDeps;
  store: MemoryBotStore;
  x: FakeXClient;
  chain: { executed: TradePlan[]; balances: { eth: bigint; token: bigint }; launchTime: number; approvals: { erc20: boolean; permit2: boolean } };
  script: { parse: ParseResult };
};

function harness(over: Partial<BotConfig> = {}): Harness {
  const store = new MemoryBotStore();
  store.now = () => NOW;
  store.pools.push(pool(CAT, "CAT"), pool(NVDOG, "NVDOG", { quoteAddress: NVDA, quoteSymbol: "NVDA" }));
  const x = new FakeXClient();
  const chainState = { executed: [] as TradePlan[], balances: { eth: parseEther("1"), token: parseEther("1000000") }, launchTime: 1_757_000_000, approvals: { erc20: true, permit2: true } };
  const trade: TradeChain = {
    addresses: () => ({ router: ROUTER, permit2: PERMIT2, referrer: REFERRER }),
    async poolConfig() {
      return { currentCreator: CREATOR, creatorFeeRecipient: CREATOR, baseFeeBps: 100, antiSnipeStartTotalBps: 9900, antiSnipeWindowSeconds: 20, launchTime: chainState.launchTime };
    },
    async balances() {
      return chainState.balances;
    },
    async approvals() {
      return chainState.approvals;
    },
    async quote(input) {
      return input.zeroForOne === (input.poolKey.currency0 === zeroAddress) ? input.amountIn * 1000n : input.amountIn / 1000n;
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
  const h: Harness = { store, x, chain: chainState, script: { parse: tradeCmd() }, deps: undefined as unknown as PipelineDeps };
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

  it("buys from the poster's own wallet, through the allow-list, and replies with the token page", async () => {
    enableTrading(h);
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT"), h.deps);
    expect(out).toMatchObject({ outcome: "traded", txHash: TX });
    const plan = h.chain.executed[0]!;
    expect(plan.side).toBe("buy");
    expect(plan.value).toBe(parseEther("0.05"));
    expect(plan.amountIn).toBe(parseEther("0.05"));
    expect(plan.maxValueWei).toBe(parseEther("0.1"));
    expect(plan.referrer).toBe(REFERRER);
    expect(plan.minAmountOut).toBe((plan.expectedOut * 9_700n) / 10_000n);
    const reply = h.x.replies[0]!.text;
    expect(reply).toMatch(/^Bought [\d,]+ \$CAT for 0\.05 ETH\./);
    expect(reply).toContain(`https://rh-scan.com/tx/${TX}`);
    expect(reply).toContain(`https://o1bot.exchange/token/${CAT}`);
    expect(reply.replace(`https://o1bot.exchange/token/${CAT}`, "").replace(`https://rh-scan.com/tx/${TX}`, "")).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(h.store.trades[0]).toMatchObject({ side: "BUY", status: "REPLIED", txHash: TX });
    expect(h.store.signedTxs[0]).toMatchObject({ kind: "ROUTER_EXECUTE", xUserId: "111", wallet: ALICE_WALLET, valueWei: parseEther("0.05").toString() });
    expect(h.store.mentions[0]!.status).toBe("DONE");
  });

  it("sells a portion of the holding with no native value and the approvals a sell needs", async () => {
    enableTrading(h);
    h.script.parse = tradeCmd({ side: "sell", amountEth: null, sellPortion: { kind: "percent", value: 50 } });
    const out = await processMention(mention("@o1bot_exchange sell half of $CAT"), h.deps);
    expect(out).toMatchObject({ outcome: "traded" });
    const plan = h.chain.executed[0]!;
    expect(plan.side).toBe("sell");
    expect(plan.value).toBe(0n);
    expect(plan.amountIn).toBe(parseEther("500000"));
    expect(plan.approvals).toEqual({ erc20: true, permit2: true });
    expect(h.x.replies[0]!.text).toMatch(/^Sold 500,000 \$CAT for [\d.]+ ETH\./);
  });

  it("refuses a buy above the user's own cap, and applies the deployment cap as the ceiling", async () => {
    enableTrading(h, parseEther("0.02"));
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.x.replies[0]!.text).toContain("per-trade cap of 0.02 ETH");
    h.store.trading.set("111", { enabled: true, maxTradeWei: parseEther("5") });
    h.script.parse = tradeCmd({ amountEth: "0.4" });
    await processMention(mention("@o1bot_exchange buy 0.4 ETH of $CAT", "2001"), h.deps);
    expect(h.chain.executed[0]!.maxValueWei).toBe(parseEther("0.5"));
  });

  it("refuses buys inside the anti-snipe window, unknown tickers, ambiguous tickers and stock pools", async () => {
    enableTrading(h);
    h.chain.launchTime = Math.floor(NOW.getTime() / 1000) - 5;
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2002"), h.deps);
    expect(h.x.replies.at(-1)!.text).toMatch(/anti-snipe .* 15 seconds/);
    h.chain.launchTime = 1_757_000_000;

    h.script.parse = tradeCmd({ ticker: "DOG" });
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $DOG", "2003"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("$DOG is not one of them");

    h.store.pools.push(pool(CAT2, "CAT", { launchedAt: new Date("2026-09-08T18:00:00Z") }));
    h.script.parse = tradeCmd();
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2004"), h.deps);
    const text = h.x.replies.at(-1)!.text;
    expect(text).toContain("More than one $CAT");
    expect(text).toContain(`/token/${CAT}`);
    expect(text).toContain(`/token/${CAT2}`);
    h.store.pools.pop();

    h.script.parse = tradeCmd({ ticker: "NVDOG" });
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $NVDOG", "2005"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("ETH pools only");
    expect(h.chain.executed).toHaveLength(0);
  });

  it("resolves a token given by address and enforces the cooldown between trades", async () => {
    enableTrading(h);
    h.script.parse = tradeCmd({ ticker: null, tokenAddress: CAT.toLowerCase(), amountEth: "0.01" });
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of 0x…", "2006"), h.deps);
    expect(h.chain.executed).toHaveLength(1);
    await processMention(mention("@o1bot_exchange buy 0.01 ETH of 0x…", "2007"), h.deps);
    expect(h.chain.executed).toHaveLength(1);
    expect(h.x.replies.at(-1)!.text).toContain("every few seconds");
  });

  it("tells the user the exact shortfall when the wallet cannot cover amount plus gas", async () => {
    enableTrading(h);
    h.chain.balances = { eth: parseEther("0.05"), token: 0n };
    await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2008"), h.deps);
    const text = h.x.replies.at(-1)!.text;
    expect(text).toMatch(/is 0\.0\d+ ETH short/);
    expect(h.chain.executed).toHaveLength(0);
    // Shortfall = gas at the fee cap (the wallet holds exactly the amount), rounded up to 4 decimals.
    expect(text).toContain(formatEthCeil(SWAP_GAS * 1_000_000_000n));
  });

  it("records a dry run without signing", async () => {
    h = harness({ dryRun: true });
    enableTrading(h);
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT", "2009"), h.deps);
    expect(out).toMatchObject({ outcome: "trade_dry_run" });
    expect(h.chain.executed).toHaveLength(0);
    expect(h.store.trades[0]).toMatchObject({ status: "DRY_RUN" });
    expect(h.x.replies).toHaveLength(0);
  });

  it("never trades for a poster who is not linked", async () => {
    enableTrading(h);
    h.deps.resolveLink = async () => ({ linked: false, reason: "not_delegated", user: null });
    const out = await processMention(mention("@o1bot_exchange sell all $CAT", "2010"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "not_registered" });
    expect(h.chain.executed).toHaveLength(0);
  });
});
