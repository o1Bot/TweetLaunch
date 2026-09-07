import { z } from "zod";

/**
 * The model's structured output. One flat object (structured outputs are
 * happiest without top-level unions); `normalizeParseOutput` turns it into
 * the discriminated `ParseResult` the rest of the bot consumes.
 */

export const MISSING_FIELDS = ["ticker", "name", "pair", "devbuy_amount", "fees_to_handle"] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

export const ParseOutputSchema = z.object({
  kind: z
    .enum(["launch", "clarify", "help", "ignore"])
    .describe("launch: a complete launch command. clarify: launch intent but a required value is missing or ambiguous. help: a question about the bot, wallet, fees or pairs. ignore: no actionable intent, spam or abuse."),
  language: z.string().describe("BCP-47 language tag of the post, e.g. en, id, es, ja."),
  ticker: z
    .string()
    .nullable()
    .describe("Ticker exactly as the user wrote it minus a leading $, uppercased. null when not stated."),
  name: z
    .string()
    .nullable()
    .describe("Token name exactly as the user wrote it (the quoted text when quoted). null when not stated."),
  pair: z
    .string()
    .nullable()
    .describe("Paired asset symbol from the pair list: ETH, USDG or a stock symbol. Map a company name only when it is unambiguous. If the user named an asset that is not in the list, return it uppercased as written. null when not stated."),
  chain: z
    .enum(["robinhood", "base", "other"])
    .nullable()
    .describe("Chain the user named. robinhood for Robinhood Chain (aliases: rh, hood). null when no chain was named. Never default."),
  devbuy_native: z
    .string()
    .nullable()
    .describe("Dev buy amount in ETH as a plain decimal string exactly as written, e.g. \"0.05\". null when absent. If the amount is in another unit (USD, %), leave null and clarify."),
  fees_to_handle: z.string().nullable().describe("X handle without @ that should receive the creator fees. null when absent."),
  missing: z.array(z.enum(MISSING_FIELDS)).describe("For kind=clarify: the required values that are missing or ambiguous. Empty otherwise."),
  question: z.string().nullable().describe("For kind=clarify: one short question to the user in the post's language. null otherwise."),
  reply: z.string().nullable().describe("For kind=help: a reply of at most 240 characters in the post's language. null otherwise."),
  reason: z.string().describe("One short English sentence explaining the decision, for logs."),
});

export type ParseOutput = z.infer<typeof ParseOutputSchema>;
