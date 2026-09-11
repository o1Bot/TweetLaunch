import type { TokenStats } from "@o1bot/market";
import type { ChainKey } from "./chains-web";

export type QuoteKind = "eth" | "usd" | "stk";

export type Creator = {
  wallet: string;
  xHandle: string | null;
  xName: string | null;
  xAvatarUrl: string | null;
};

export type GenesisPost = {
  tweetId: string;
  text: string;
  postedAt: string | null;
};

export type TokenRow = {
  token: string;
  chainId: number;
  chain: ChainKey;
  name: string;
  symbol: string;
  imageUrl: string | null;
  quoteSymbol: string;
  quoteAddress: string;
  quoteDecimals: number;
  quoteKind: QuoteKind;
  launchedAt: string;
  launchTxHash: string;
  creator: Creator;
  post: GenesisPost | null;
  stats: TokenStats;
  tradeCount: number;
  source: "BOT" | "DEV";
  /** Tokens sent to the dead address (human units); market cap counts the rest. */
  burnedTokens: number;
  circulatingTokens: number;
  /** The token's site on the sandbox domain, when one is live. */
  siteUrl: string | null;
};

export type TradeRow = {
  id: string;
  time: string;
  side: "BUY" | "SELL";
  /** Human units. */
  amountToken: number;
  amountQuote: number;
  priceQuote: number;
  trader: string;
  txHash: string;
  comment: string | null;
  /** The swap was asked for in a post and signed by the bot. */
  viaPost: boolean;
};

export type TokenDetail = TokenRow & {
  poolId: string;
  tickSpacing: number;
  hook: string;
  factory: string;
  launchBlock: string;
  supplyTokens: number;
  metadataUri: string | null;
  /** Hook fees paid in the quote asset since launch (human units); the creator's share is half. */
  feesQuoteTotal: number;
  trades: TradeRow[];
};

export type Holder = {
  address: string;
  /** Human units when known. */
  balance: number | null;
  percent: number | null;
  label: string | null;
};

export type HoldersResult = {
  holders: Holder[];
  total: number | null;
  source: "o1";
  error: string | null;
};
