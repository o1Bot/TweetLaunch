import { z } from "zod";

/**
 * The model's structured output. One flat object (structured outputs are
 * happiest without top-level unions); `normalizeParseOutput` turns it into
 * the discriminated `ParseResult` the rest of the bot consumes.
 */

export const MISSING_FIELDS = ["ticker", "name", "pair", "devbuy_amount", "fees_to_handle", "trade_side", "trade_token", "trade_amount", "bridge_chain"] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

export const ParseOutputSchema = z.object({
  kind: z
    .enum(["launch", "trade", "bridge", "clarify", "help", "ignore"])
    .describe(
      "launch: a complete launch command. trade: a complete buy or sell command for the poster's own wallet. bridge: a complete request to move ETH from another chain to the poster's own wallet on Robinhood. clarify: launch, trade or bridge intent but a required value is missing or ambiguous. help: a question about the bot, wallet, fees or pairs, or a request the bot cannot do. ignore: no actionable intent, spam or abuse.",
    ),
  language: z.string().describe("BCP-47 language tag of the post, e.g. en, id, es, ja."),
  ticker: z
    .string()
    .nullable()
    .describe("The token: for a launch its new ticker, for a trade the ticker of the token to trade, exactly as the user wrote it minus a leading $, uppercased. For a trade the user may give a 0x contract address instead; return it exactly as written. null when not stated."),
  name: z
    .string()
    .nullable()
    .describe("Launch only. Token name exactly as the user wrote it (the quoted text when quoted). null when not stated."),
  pair: z
    .string()
    .nullable()
    .describe("Launch only. Paired asset symbol from the pair list: ETH, USDG or a stock symbol. Map a company name only when it is unambiguous. If the user named an asset that is not in the list, return it uppercased as written. null when not stated."),
  chain: z
    .enum(["robinhood", "base", "ethereum", "arbitrum", "optimism", "other"])
    .nullable()
    .describe(
      "Chain the user named. For a launch, the chain to launch on. For a trade or a bridge, the chain the ETH comes from (\"from base\", \"from arbitrum\"). robinhood for Robinhood Chain (aliases: rh, hood); ethereum for Ethereum mainnet (aliases: eth mainnet, mainnet, L1); arbitrum (arb, arbitrum one); optimism (op, op mainnet); other for any other chain. null when no chain was named. Never default.",
    ),
  devbuy_native: z
    .string()
    .nullable()
    .describe("Launch only. Dev buy amount in ETH as a plain decimal string exactly as written, e.g. \"0.05\". null when absent. If the amount is in another unit (USD, %), leave null and clarify."),
  fees_to_handle: z.string().nullable().describe("Launch only. X handle without @ that should receive the creator fees. null when absent."),
  description: z
    .string()
    .nullable()
    .describe('Launch only. Token description the user gave explicitly (after "desc", "description" or "about", or a quoted tagline that is clearly about the token). Verbatim, not invented. null when absent.'),
  website: z.string().nullable().describe("Launch only. Project website URL the user gave (after \"site\", \"website\" or as a bare URL that is not a t.me or x.com link). null when absent."),
  telegram: z.string().nullable().describe("Launch only. Telegram link or @handle the user gave (after \"tg\", \"telegram\" or a t.me URL). null when absent."),
  x_handle: z.string().nullable().describe("Launch only. Project X handle without @ when the user names one for the token's profile (after \"x\" or \"twitter\", or an x.com link). null when absent; the poster's own account is used then."),
  trade_side: z.enum(["buy", "sell"]).nullable().describe("Trade only. buy or sell as the user asked. null when the post is not a trade or the side is unclear."),
  trade_amount: z
    .string()
    .nullable()
    .describe(
      'Trade or bridge. For a bridge: the ETH to move exactly as written ("0.1", "0.1 ETH"). For a buy: the amount to spend exactly as written, with the asset when the user named one ("0.05", "0.05 ETH", "5 NVDA", "20 USDG"); null when absent or given in USD, in tokens of the token being bought, or as a percentage. For a sell: how much of the holding, exactly as written: "all", "half", "quarter", or a percentage such as "25" or "25%"; null when absent or given in tokens or ETH.',
    ),
  trade_slippage_pct: z.string().nullable().describe('Trade only. Slippage the user asked for as a plain number in percent ("5" for 5%). null when absent.'),
  missing: z.array(z.enum(MISSING_FIELDS)).describe("For kind=clarify: the required values that are missing or ambiguous. Empty otherwise."),
  question: z.string().nullable().describe("For kind=clarify: one short question to the user in the post's language. null otherwise."),
  reply: z.string().nullable().describe("For kind=help: a reply of at most 240 characters in the post's language. null otherwise."),
  reason: z.string().describe("One short English sentence explaining the decision, for logs."),
});

export type ParseOutput = z.infer<typeof ParseOutputSchema>;
