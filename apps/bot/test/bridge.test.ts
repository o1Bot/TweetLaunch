import { beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { poolIdOf } from "@o1bot/executor";
import type { ParsedMention, ParseResult } from "@o1bot/parser";
import { buildBridgeAllowlist, checkTransaction, RELAY_DEPOSITORY, RESERVED_HANDLES } from "@o1bot/shared";
import { launchPoolKey } from "@o1bot/swap";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient, type XMention } from "@o1bot/x";
import { depositForBuy, type BridgeChain, type BridgePlan } from "../src/bridge-core";
import type { BotConfig } from "../src/config";
import { processMention, type PipelineDeps } from "../src/pipeline";
import type { RelayClient, RelayQuote, RelayStatus } from "../src/relay";
import { MemoryAskData } from "../src/ask-data";
import { MemoryBotStore, type TradableToken } from "../src/store";
import type { TradeChain, TradePlan } from "../src/trade-core";

/**
 * Bridges from a post, end to end with fakes: a scripted parser, a fake
 * Relay that answers quotes and statuses, a fake origin chain that checks
 * the deposit against the real bridge allow-list, and a fake Robinhood
 * chain for the buy that can follow.
 */

const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const CAT: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const HOOK: Address = getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc");
const ROUTER: Address = getAddress("0x3333333333333333333333333333333333333333");
const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const REFERRER: Address = getAddress("0x2222222222222222222222222222222222222222");
const CREATOR: Address = getAddress("0x4444444444444444444444444444444444444444");
const DEPOSIT_TX: Hex = `0x${"aa".repeat(32)}`;
const FILL_TX: Hex = `0x${"bb".repeat(32)}`;
const SWAP_TX: Hex = `0x${"cc".repeat(32)}`;
const NOW = new Date("2026-09-09T10:00:00Z");
const depositAbi = parseAbi(["function depositNative(address to, bytes32 id)"]);

const mention = (text: string, id = "3000"): XMention => ({ id, text, authorId: "111", authorHandle: "alice", authorName: "Alice", authorImage: null, imageUrl: null, createdAt: NOW.toISOString(), lang: "en", referenced: [] });

const bridgeCmd = (over: Partial<Extract<ParseResult, { kind: "bridge" }>> = {}): ParseResult => ({ kind: "bridge", fromChain: "base", amount: "0.1", language: "en", reason: "test", ...over });
const buyFromCmd = (): ParseResult => ({ kind: "trade", side: "buy", ticker: "CAT", tokenAddress: null, amount: "0.05", amountSymbol: null, sellPortion: null, slippageBps: null, fromChain: "base", language: "en", reason: "test" });

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
    tradeCooldownSeconds: 0,
    maxTradesPerDay: 20,
    tradeSlippageBps: 300,
    maxBridgeWei: parseEther("1"),
    siteUrl: "https://o1bot.exchange",
    botHandle: "o1bot_exchange",
    botUserId: "999",
    reservedHandles: [...RESERVED_HANDLES],
    ...over,
  };
}

function linked(): LinkStatus {
  const user: LinkedUser = { privyUserId: "did:privy:alice", xUserId: "111", xHandle: "alice", xName: "Alice", xAvatarUrl: null, wallet: { address: ALICE_WALLET, walletId: "wallet-alice", delegated: true }, hasLoggedIn: true, pregenerated: false };
  return { linked: true, user, wallet: user.wallet! };
}

type State = {
  originBalance: bigint;
  deposits: BridgePlan[];
  quotes: number;
  statuses: RelayStatus["status"][];
  swaps: TradePlan[];
  robinhoodEth: bigint;
};
type Harness = { deps: PipelineDeps; store: MemoryBotStore; x: FakeXClient; state: State; script: { parse: ParseResult } };

function harness(over: Partial<BotConfig> = {}): Harness {
  const store = new MemoryBotStore();
  store.now = () => NOW;
  const pool: TradableToken = { token: CAT, symbol: "CAT", name: "CAT", quoteAddress: zeroAddress, quoteSymbol: "ETH", quoteDecimals: 18, tickSpacing: 200, hook: HOOK, poolId: poolIdOf(launchPoolKey(CAT, zeroAddress, 200, HOOK)), launchedAt: new Date("2026-09-07T18:00:00Z"), source: "bot", liquidityUsd: null };
  store.pools.push(pool);
  const x = new FakeXClient();
  const state: State = { originBalance: parseEther("1"), deposits: [], quotes: 0, statuses: ["pending", "success"], swaps: [], robinhoodEth: parseEther("0.001") };

  const relay: RelayClient = {
    async quote(input): Promise<RelayQuote> {
      state.quotes++;
      const requestId = `0x${"ab".repeat(32)}` as Hex;
      return {
        requestId,
        depositId: requestId,
        chainId: input.originChainId,
        to: RELAY_DEPOSITORY,
        data: encodeFunctionData({ abi: depositAbi, functionName: "depositNative", args: [zeroAddress, requestId] }),
        value: input.amountWei,
        amountOut: (input.amountWei * 9_980n) / 10_000n,
        timeEstimate: 1,
      };
    },
    async status() {
      const next = state.statuses.shift() ?? "success";
      return { status: next, fillTxHash: next === "success" ? FILL_TX : null };
    },
  };
  const bridge: BridgeChain = {
    async balance() {
      return state.originBalance;
    },
    async fees() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n };
    },
    async deposit(plan, wallet, audit) {
      const list = buildBridgeAllowlist({ chainId: plan.chainId, depository: plan.to, wallet: plan.wallet, depositId: plan.depositId, amountWei: plan.value });
      const check = checkTransaction(list, { chainId: plan.chainId, to: plan.to, data: plan.data, value: plan.value });
      if (!check.ok) throw new Error(`allow-list refused: ${check.reason}`);
      await audit({ kind: "relayDeposit", chainId: plan.chainId, wallet: wallet.address, to: plan.to, calldataHash: `0x${"00".repeat(32)}`, valueWei: plan.value.toString() });
      state.deposits.push(plan);
      state.originBalance -= plan.value;
      state.robinhoodEth += plan.amountOut;
      return { txHash: DEPOSIT_TX };
    },
    sleep: async () => undefined,
  };
  const trade: TradeChain = {
    addresses: () => ({ router: ROUTER, permit2: PERMIT2, referrer: REFERRER }),
    async poolConfig() {
      return { initialized: true, currentCreator: CREATOR, creatorFeeRecipient: CREATOR, baseFeeBps: 100, antiSnipeStartTotalBps: 9900, antiSnipeWindowSeconds: 20, launchTime: 1_757_000_000 };
    },
    async balances() {
      return { eth: state.robinhoodEth, token: 0n, quote: state.robinhoodEth };
    },
    async approvals() {
      return { erc20: false, permit2: false };
    },
    async quote(input) {
      return input.amountIn * 1000n;
    },
    async usdPrice() {
      return 2500;
    },
    async fees() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n };
    },
    async execute(plan) {
      state.swaps.push(plan);
      return { txHash: SWAP_TX, amountOut: plan.expectedOut };
    },
  };
  const h: Harness = { store, x, state, script: { parse: bridgeCmd() }, deps: undefined as unknown as PipelineDeps };
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
    o1Tokens: { search: async () => [], byAddress: async () => null },
    askData: new MemoryAskData(),
    bridge,
    relay,
    now: () => NOW,
  };
  return h;
}

const enableTrading = (h: Harness) => h.store.trading.set("111", { enabled: true, maxTradeWei: null });

describe("bridges from a post", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses until trading from posts is on", async () => {
    const out = await processMention(mention("@o1bot_exchange bridge 0.1 ETH from base"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "rejected" });
    expect(h.state.deposits).toHaveLength(0);
  });

  it("deposits exactly what Relay quoted, waits for the fill, and replies with the amounts", async () => {
    enableTrading(h);
    const out = await processMention(mention("@o1bot_exchange bridge 0.1 ETH from base"), h.deps);
    expect(out).toMatchObject({ outcome: "bridged", depositTxHash: DEPOSIT_TX, fillTxHash: FILL_TX });
    const plan = h.state.deposits[0]!;
    expect(plan.chainId).toBe(8453);
    expect(plan.to).toBe(RELAY_DEPOSITORY);
    expect(plan.value).toBe(parseEther("0.1"));
    expect(plan.wallet).toBe(ALICE_WALLET);
    const reply = h.x.replies[0]!.text;
    expect(reply).toContain("0.1 ETH from Base");
    expect(reply).toContain("0.0998");
    expect(reply).toContain(`https://rh-scan.com/tx/${FILL_TX}`);
    expect(h.store.bridges[0]).toMatchObject({ status: "FILLED", depositTxHash: DEPOSIT_TX, fillTxHash: FILL_TX, originChainId: 8453 });
    expect(h.store.signedTxs[0]).toMatchObject({ kind: "RELAY_DEPOSIT", chainId: 8453, valueWei: parseEther("0.1").toString() });
    expect(h.store.mentions[0]!.status).toBe("DONE");
  });

  it("refuses an amount above the bridge cap and a wallet that cannot cover deposit plus gas", async () => {
    enableTrading(h);
    h.script.parse = bridgeCmd({ amount: "2" });
    await processMention(mention("@o1bot_exchange bridge 2 ETH from base", "3001"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("cap of 1 ETH");
    h.script.parse = bridgeCmd({ amount: "0.1" });
    h.state.originBalance = parseEther("0.1");
    await processMention(mention("@o1bot_exchange bridge 0.1 ETH from base", "3002"), h.deps);
    expect(h.x.replies.at(-1)!.text).toMatch(/Base wallet is 0\.0\d+ ETH short/);
    expect(h.state.deposits).toHaveLength(0);
  });

  it("reports a refund and a fill that is late", async () => {
    enableTrading(h);
    h.state.statuses = ["pending", "refund"];
    await processMention(mention("@o1bot_exchange bridge 0.1 ETH from base", "3003"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("refunded");
    expect(h.store.bridges.at(-1)).toMatchObject({ status: "FAILED" });

    h = harness({ dryRun: false });
    enableTrading(h);
    // Relay never reports success; the injected clock runs a minute per look, so the two-minute wait ends after a few polls.
    h.deps.relay.status = async () => ({ status: "pending", fillTxHash: null });
    let t = NOW.getTime();
    h.deps.now = () => {
      t += 60_000;
      return new Date(t);
    };
    await processMention(mention("@o1bot_exchange bridge 0.1 ETH from base", "3004"), h.deps);
    expect(h.x.replies.at(-1)!.text).toContain("still on its way");
    expect(h.store.bridges.at(-1)).toMatchObject({ status: "DEPOSITED", depositTxHash: DEPOSIT_TX });
  });

  it("bridges a little more than the buy, then buys on Robinhood, and replies once with both", async () => {
    enableTrading(h);
    h.script.parse = buyFromCmd();
    const out = await processMention(mention("@o1bot_exchange buy 0.05 ETH of $CAT from base", "3005"), h.deps);
    expect(out).toMatchObject({ outcome: "traded", txHash: SWAP_TX });
    expect(h.state.deposits[0]!.value).toBe(depositForBuy(parseEther("0.05")));
    expect(h.state.swaps).toHaveLength(1);
    expect(h.state.swaps[0]!.amountIn).toBe(parseEther("0.05"));
    const reply = h.x.replies[0]!.text;
    expect(reply).toContain("Bridged");
    expect(reply).toMatch(/Bought [\d,]+ \$CAT for 0\.05 ETH/);
    expect(h.x.replies).toHaveLength(1);
  });

  it("records a dry run without signing", async () => {
    h = harness({ dryRun: true });
    enableTrading(h);
    const out = await processMention(mention("@o1bot_exchange bridge 0.1 ETH from base", "3006"), h.deps);
    expect(out).toMatchObject({ outcome: "bridge_dry_run" });
    expect(h.state.deposits).toHaveLength(0);
    expect(h.store.bridges[0]).toMatchObject({ status: "DRY_RUN" });
  });
});
