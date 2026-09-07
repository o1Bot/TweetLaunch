import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env, logger, o1Chain, requireEnv } from "@o1bot/shared";
import { normalizeParseOutput, type ParseResult } from "./normalize";
import { buildSystemPrompt, buildUserMessage, type MentionInput, type PromptContext } from "./prompt";
import { ParseOutputSchema } from "./schema";

/**
 * One Claude call per mention, structured output validated against the zod
 * schema, then deterministic normalisation. Default model:
 * claude-sonnet-4-6 (override with PARSER_MODEL).
 */

export const DEFAULT_PARSER_MODEL = "claude-sonnet-4-6";

export class ParserError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ParserError";
  }
}

export type ParseOptions = {
  client?: Anthropic;
  model?: string;
  context?: Partial<PromptContext>;
};

let cachedClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return cachedClient;
}

/** Sampling parameters are rejected by the 5-series models; only send them where they exist. */
function supportsTemperature(model: string): boolean {
  return /-4-\d/.test(model) || /-3-\d/.test(model);
}

export function promptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  const e = env();
  const chain = o1Chain("robinhood");
  const creatorBps = chain.feeConfiguration.components.find((c) => c.recipientKind === "creator")?.feeBps ?? 50;
  return {
    botHandle: e.X_BOT_HANDLE,
    siteUrl: e.SITE_URL.replace(/\/$/, ""),
    creationFee: chain.snapshot.nativeLaunchFeeDisplay,
    creatorShare: `${(creatorBps / 100).toString()}%`,
    ...overrides,
  };
}

export type ParsedMention = {
  result: ParseResult;
  /** Raw model output, stored verbatim on the Mention row. */
  raw: unknown;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export async function parseMention(input: MentionInput, opts: ParseOptions = {}): Promise<ParsedMention> {
  const client = opts.client ?? anthropic();
  const model = opts.model ?? env().PARSER_MODEL ?? DEFAULT_PARSER_MODEL;
  const system = buildSystemPrompt(promptContext(opts.context));

  const callModel = async () => {
    try {
      return await client.messages.parse({
        model,
        max_tokens: 1024,
        ...(supportsTemperature(model) ? { temperature: 0 } : {}),
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(input) }],
        output_config: { format: zodOutputFormat(ParseOutputSchema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new ParserError(`anthropic ${err.status ?? ""} ${err.message}`.trim(), err);
      throw new ParserError(err instanceof Error ? err.message : String(err), err);
    }
  };
  const response = await callModel();

  const usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    logger.warn({ tweetId: input.tweetId, category: response.stop_details?.category }, "parser refusal");
    return { result: { kind: "ignore", language: "en", reason: "model refused to process the post" }, raw: null, model, usage };
  }
  if (response.stop_reason === "max_tokens") throw new ParserError("parser output truncated (max_tokens)");

  const parsed = response.parsed_output;
  if (!parsed) throw new ParserError("parser returned no structured output");

  const result = normalizeParseOutput(parsed, { hasImage: input.hasImage });
  logger.info({ tweetId: input.tweetId, kind: result.kind, model, usage }, "parsed mention");
  return { result, raw: parsed, model, usage };
}
