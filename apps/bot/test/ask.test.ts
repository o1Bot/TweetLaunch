import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address } from "viem";
import type { AskCommand, ComposeInput, ParsedMention, ParseResult } from "@o1bot/parser";
import { RESERVED_HANDLES } from "@o1bot/shared";
import type { LinkedUser, LinkStatus } from "@o1bot/wallet";
import { FakeXClient, XPostError, type XMention } from "@o1bot/x";
import { MemoryAskData, type TokenSummary, type WalletSummary } from "../src/ask-data";
import { MemorySiteStore } from "../src/site-store";
import { ago, amount, money, price, sig, tokenAmount } from "../src/ask-handler";
import { dryRunBridgeChain } from "../src/bridge-chain";
import type { BotConfig } from "../src/config";
import { noO1Tokens } from "../src/o1-tokens";
import { processMention, type PipelineDeps } from "../src/pipeline";
import { MemoryBotStore } from "../src/store";
import { dryRunTradeChain } from "../src/trade-chain";

/**
 * Questions from posts, end to end with fakes: the parser is scripted to an
 * AskCommand, the figures come from MemoryAskData, and `compose` is either
 * absent (template replies) or scripted. No X, no Anthropic, no chain.
 */

const NOW = new Date("2026-09-11T10:00:00Z");
const ALICE_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const CAT: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const SITE = "https://o1bot.exchange";

const post = (text: string, over: Partial<XMention> = {}): XMention => ({
  id: "5000",
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

const ask = (over: Partial<AskCommand> = {}): AskCommand => ({ kind: "ask", topic: "stats", ticker: null, tokenAddress: null, chain: null, language: "en", reason: "test", ...over });

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

const cat: TokenSummary = {
  token: CAT,
  symbol: "CAT",
  name: "Cash Cat",
  chain: "robinhood",
  quoteSymbol: "ETH",
  priceQuote: 0.00012,
  priceUsd: 0.31,
  change24hPct: 12.5,
  volume24hUsd: 4200,
  volumeAllUsd: 50100,
  mcapUsd: 310000,
  trades: 123,
  holders: 57,
  launchedAt: new Date(NOW.getTime() - 3 * 24 * 3600 * 1000),
  creatorHandle: "alice",
  creatorFeesQuote: 0.05,
};

const aliceWallet: WalletSummary = {
  address: ALICE_WALLET,
  eth: [
    { chain: "robinhood", eth: "0.4213", usd: 1050 },
    { chain: "base", eth: "0.1", usd: 250 },
  ],
  quotes: [{ chain: "robinhood", symbol: "USDG", balance: "20.5", usd: 20.5 }],
  tokens: [{ chain: "robinhood", symbol: "CAT", balance: "1234567", usd: 12.1 }],
  tokensCount: 1,
  feesOwed: [{ chain: "robinhood", symbol: "ETH", balance: "0.012", usd: 30 }],
  totalUsd: 1362.6,
};

/** A fake X that refuses the first reply carrying a 0x address the way X does for young accounts. */
class AddressBlockingX extends FakeXClient {
  blocked = 0;
  override async postReply(text: string, inReplyTo: string): Promise<string> {
    if (/0x[0-9a-fA-F]{40}/.test(text)) {
      this.blocked++;
      throw new XPostError("forbidden", 403, '{"detail":"Crypto addresses are prohibited"}');
    }
    return super.postReply(text, inReplyTo);
  }
}

type Harness = {
  deps: PipelineDeps;
  store: MemoryBotStore;
  x: FakeXClient;
  askData: MemoryAskData;
  script: { parse: ParseResult; link: LinkStatus };
  composeCalls: ComposeInput[];
  composeResult: string | null | undefined;
};

function harness(over: { x?: FakeXClient; compose?: boolean; config?: Partial<BotConfig> } = {}): Harness {
  const store = new MemoryBotStore();
  const x = over.x ?? new FakeXClient();
  const askData = new MemoryAskData();
  const h: Harness = { store, x, askData, script: { parse: ask(), link: linked() }, composeCalls: [], composeResult: undefined, deps: undefined as unknown as PipelineDeps };
  h.deps = {
    store,
    x,
    config: config(over.config),
    parse: async (): Promise<ParsedMention> => ({ result: h.script.parse, raw: {}, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    localize: async (text) => text,
    resolveLink: async () => h.script.link,
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
    trade: dryRunTradeChain(),
    o1Tokens: noO1Tokens,
    bridge: dryRunBridgeChain(),
    relay: { quote: async () => { throw new Error("not used"); }, status: async () => ({ status: "unknown", fillTxHash: null }) },
    askData,
    sites: new MemorySiteStore(store),
    generateSite: async () => {
      throw new Error("not used");
    },
    ...(over.compose
      ? {
          compose: async (input: ComposeInput) => {
            h.composeCalls.push(input);
            return h.composeResult ?? null;
          },
        }
      : {}),
    now: () => NOW,
  };
  return h;
}

describe("questions answered from the data", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("answers platform statistics with the template when there is no composer", async () => {
    h.askData.stats = { launches: { total: 85, robinhood: 85, base: 0 }, trades: 4321, volume24hUsd: 12300, volumeAllUsd: 1230000, latest: { symbol: "CAT", chain: "robinhood", launchedAt: cat.launchedAt } };
    const out = await processMention(post("how many tokens have you launched?"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "ask" });
    const text = h.x.replies[0]?.text ?? "";
    expect(text).toContain("85 tokens launched through o1bot");
    expect(text).toContain("$12.3K");
    expect(text).toContain("$1.23M");
    expect(text).toContain("4,321 trades");
    expect(text).toContain(SITE);
    expect(h.store.mentions[0]?.status).toBe("DONE");
  });

  it("scopes statistics to the chain the post named", async () => {
    h.script.parse = ask({ chain: "base" });
    h.askData.stats = { launches: { total: 2, robinhood: 0, base: 2 }, trades: 10, volume24hUsd: null, volumeAllUsd: null, latest: null };
    await processMention(post("how many on base?"), h.deps);
    expect(h.x.replies[0]?.text).toContain("2 tokens launched through o1bot on Base, unknown traded");

    h.askData.stats = { launches: { total: 0, robinhood: 0, base: 0 }, trades: 0, volume24hUsd: null, volumeAllUsd: null, latest: null };
    await processMention(post("how many on base?", { id: "5001" }), h.deps);
    expect(h.x.replies[1]?.text).toContain("No token has been launched through o1bot on Base yet");
  });

  it("ranks the most traded tokens and says so when there are none", async () => {
    h.script.parse = ask({ topic: "top" });
    await processMention(post("what is trending?"), h.deps);
    expect(h.x.replies[0]?.text).toContain("No token has been launched through o1bot yet");
    h.askData.tokens = [cat, { ...cat, token: getAddress("0x2222222222222222222222222222222222222201"), symbol: "DOG", name: "Dog", volume24hUsd: 9000 }];
    await processMention(post("what is trending?", { id: "5001" }), h.deps);
    expect(h.x.replies[1]?.text).toMatch(/1\) \$DOG \$9\.0K.*2\) \$CAT \$4\.2K/);
  });

  it("describes one token with its market data and page", async () => {
    h.askData.tokens = [cat];
    h.script.parse = ask({ topic: "token", ticker: "CAT" });
    await processMention(post("how is $CAT doing?"), h.deps);
    const text = h.x.replies[0]?.text ?? "";
    expect(text).toContain("$CAT (Cash Cat) on Robinhood Chain");
    expect(text).toContain("$0.31");
    expect(text).toContain("+12.5%");
    expect(text).toContain("$310.0K market cap");
    expect(text).toContain("57 holders");
    expect(text).toContain("launched by @alice");
    expect(text).toContain(`${SITE}/token/${CAT}`);
  });

  it("says plainly when the token never came through the bot, and lists the candidates when several share a ticker", async () => {
    h.script.parse = ask({ topic: "token", ticker: "DOG" });
    await processMention(post("how is $DOG doing?"), h.deps);
    expect(h.x.replies[0]?.text).toContain("No $DOG was launched through o1bot");

    h.askData.tokens = [cat, { ...cat, token: getAddress("0x3333333333333333333333333333333333333301"), name: "Other Cat" }];
    h.script.parse = ask({ topic: "token", ticker: "CAT" });
    await processMention(post("how is $CAT doing?", { id: "5001" }), h.deps);
    const text = h.x.replies[1]?.text ?? "";
    expect(text).toContain("More than one $CAT");
    expect(text).toContain(CAT);
    expect(text).toContain("Other Cat");
  });

  it("finds a token by address", async () => {
    h.askData.tokens = [cat];
    h.script.parse = ask({ topic: "token", tokenAddress: CAT.toLowerCase() });
    await processMention(post(`stats for ${CAT}`), h.deps);
    expect(h.x.replies[0]?.text).toContain("$CAT (Cash Cat)");
  });

  it("refuses personal questions from accounts that are not linked, without touching the data", async () => {
    h.script.parse = ask({ topic: "wallet" });
    h.script.link = { linked: false, reason: "no_account", user: null };
    const out = await processMention(post("what is my balance?"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "not_registered" });
    expect(h.x.replies[0]?.text).toContain(SITE);
    expect(h.store.mentions[0]?.status).toBe("NOT_REGISTERED");
  });

  it("reports the linked wallet's balances, tokens and claimable fees", async () => {
    h.askData.wallets.set(ALICE_WALLET.toLowerCase(), aliceWallet);
    h.script.parse = ask({ topic: "wallet" });
    await processMention(post("what is my ETH balance?"), h.deps);
    const text = h.x.replies[0]?.text ?? "";
    expect(text).toContain(ALICE_WALLET);
    expect(text).toContain("0.4213 on Robinhood Chain");
    expect(text).toContain("0.1 on Base");
    expect(text).toContain("20.5 USDG");
    expect(text).toContain("$CAT 1.23M");
    expect(text).toContain("claimable fees 0.012 ETH");
    expect(text).toContain(`${SITE}/me`);
  });

  it("falls back to the address-free wallet reply when X refuses the address", async () => {
    const x = new AddressBlockingX();
    h = harness({ x });
    h.askData.wallets.set(ALICE_WALLET.toLowerCase(), aliceWallet);
    h.script.parse = ask({ topic: "wallet" });
    const out = await processMention(post("what is my deposit address?"), h.deps);
    expect(out).toMatchObject({ outcome: "replied", kind: "ask" });
    expect(x.blocked).toBe(1);
    expect(x.replies).toHaveLength(1);
    expect(x.replies[0]?.text).not.toContain(ALICE_WALLET);
    expect(x.replies[0]?.text).toContain("Address, details and deposit");
  });

  it("lists the poster's launches with their numbers, and the claimable and earned fees", async () => {
    h.askData.launches.set("111", {
      total: 3,
      pending: 0,
      failed: 1,
      live: [
        { ticker: "CAT", name: "Cash Cat", chain: "robinhood", status: "REPLIED", token: CAT, createdAt: cat.launchedAt, quoteSymbol: "ETH", priceUsd: 0.31, change24hPct: 12.5, volumeAllUsd: 50100, creatorFeesQuote: 0.05, creatorFeesUsd: 125 },
        { ticker: "DOG", name: "Dog", chain: "base", status: "REPLIED", token: null, createdAt: NOW, quoteSymbol: "USDC", priceUsd: null, change24hPct: null, volumeAllUsd: null, creatorFeesQuote: 0, creatorFeesUsd: 0 },
      ],
    });
    h.askData.wallets.set(ALICE_WALLET.toLowerCase(), aliceWallet);

    h.script.parse = ask({ topic: "launches" });
    await processMention(post("how are my launches doing?"), h.deps);
    const launches = h.x.replies[0]?.text ?? "";
    expect(launches).toContain("2 live launches");
    expect(launches).toContain("$CAT $50.1K volume, 0.05 ETH fees");
    expect(launches).toContain("$DOG unknown volume, 0 USDC fees");

    h.script.parse = ask({ topic: "fees" });
    await processMention(post("how much can I claim?", { id: "5001" }), h.deps);
    const fees = h.x.replies[1]?.text ?? "";
    expect(fees).toContain("claimable now: 0.012 ETH on Robinhood Chain ($30.00)");
    expect(fees).toContain("Earned so far: $CAT 0.05 ETH ($125.00)");
  });

  it("lists the poster's trades from posts", async () => {
    h.script.parse = ask({ topic: "trades" });
    await processMention(post("show my trades"), h.deps);
    expect(h.x.replies[0]?.text).toContain("No trade from a post on this account yet");

    h.askData.trades.set("111", {
      total: 2,
      recent: [
        { side: "BUY", tokenSymbol: "CAT", quoteSymbol: "ETH", amountIn: "0.05", amountOut: "1234567", status: "REPLIED", createdAt: new Date(NOW.getTime() - 2 * 3600 * 1000) },
        { side: "SELL", tokenSymbol: "CAT", quoteSymbol: "ETH", amountIn: "500000", amountOut: null, status: "FAILED", createdAt: new Date(NOW.getTime() - 26 * 3600 * 1000) },
      ],
    });
    await processMention(post("show my trades", { id: "5001" }), h.deps);
    const text = h.x.replies[1]?.text ?? "";
    expect(text).toContain("2 trades from posts so far");
    expect(text).toContain("bought 1.23M $CAT for 0.05 ETH, 2 hours ago (confirmed)");
    expect(text).toContain("sold 500.0K $CAT, 26 hours ago (failed)");
  });

  it("posts the composed answer when there is one, with the facts and the post's language", async () => {
    h = harness({ compose: true });
    h.askData.stats = { launches: { total: 85, robinhood: 85, base: 0 }, trades: 4321, volume24hUsd: 12300, volumeAllUsd: 1230000, latest: null };
    h.composeResult = "85 tokens so far, $12.3K traded in the last 24h.";
    h.script.parse = ask({ language: "id" });
    await processMention(post("how many tokens have you launched so far?"), h.deps);
    expect(h.x.replies[0]?.text).toBe("85 tokens so far, $12.3K traded in the last 24h.");
    expect(h.composeCalls).toHaveLength(1);
    expect(h.composeCalls[0]).toMatchObject({ post: "how many tokens have you launched so far?", language: "id", botHandle: "o1bot_exchange", siteUrl: SITE });
    expect(h.composeCalls[0]?.facts).toContain("Tokens launched through o1bot: 85 in total");
    expect(h.composeCalls[0]?.facts).toContain("$1.23M");
  });

  it("uses the template when the composer declines, and English when the profile asks for it", async () => {
    h = harness({ compose: true });
    h.store.prefs.set("111", { acceptFeeRedirects: true, replyLanguage: "en" });
    h.composeResult = null;
    h.script.parse = ask({ language: "id" });
    await processMention(post("how many tokens so far?"), h.deps);
    expect(h.composeCalls[0]?.language).toBe("en");
    expect(h.x.replies[0]?.text).toContain("No token has been launched through o1bot yet");
  });

  it("fails soft when the data cannot be read", async () => {
    h.askData.platformStats = async () => {
      throw new Error("db down");
    };
    const out = await processMention(post("how many tokens?"), h.deps);
    expect(out).toMatchObject({ outcome: "failed", error: "ask stats: db down" });
    expect(h.x.replies[0]?.text).toContain("could not read those numbers");
    expect(h.store.mentions[0]?.status).toBe("FAILED");
  });

  it("respects the per-day reply cap like every other reply", async () => {
    h = harness({ config: { maxRepliesPerDay: 1 } });
    await processMention(post("how many tokens?"), h.deps);
    const again = await processMention(post("how many tokens?", { id: "5001" }), h.deps);
    expect(again).toMatchObject({ outcome: "replied", kind: "ask", reply: null });
    expect(h.x.replies).toHaveLength(1);
  });
});

describe("display helpers", () => {
  it("formats amounts without trailing zeros and keeps dust readable, never in exponent notation", () => {
    expect(amount("0.421300")).toBe("0.4213");
    expect(amount("1.000000000000000000")).toBe("1");
    expect(amount("0.00001234")).toBe("0.000012");
    expect(amount("0.00000061")).toBe("0.00000061");
    expect(amount(0)).toBe("0");
  });

  it("writes prices and small dollar values in plain digits", () => {
    expect(price(3.23e-7, "ETH")).toBe("0.000000323 ETH");
    expect(price(1.5, "USDG")).toBe("1.5 USDG");
    expect(price(null, "ETH")).toBe("no trade yet");
    expect(money(0.00079)).toBe("$0.00079");
    expect(money(3.23e-7)).toBe("$0.000000323");
    expect(money(0.31)).toBe("$0.31");
    expect(money(12300)).toBe("$12.3K");
    expect(money(null)).toBe("unknown");
    expect(sig(85, 3)).toBe("85");
  });

  it("compacts token balances", () => {
    expect(tokenAmount("1234567")).toBe("1.23M");
    expect(tokenAmount("45600")).toBe("45.6K");
    expect(tokenAmount("12.5")).toBe("12.5");
    expect(tokenAmount("2500000000")).toBe("2.50B");
  });

  it("says how long ago in the coarsest useful unit", () => {
    expect(ago(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(ago(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5 min ago");
    expect(ago(new Date(NOW.getTime() - 3600_000), NOW)).toBe("1 hour ago");
    expect(ago(new Date(NOW.getTime() - 3 * 86_400_000), NOW)).toBe("3 days ago");
    expect(ago(new Date(NOW.getTime() - 90 * 86_400_000), NOW)).toBe("3 months ago");
  });
});
