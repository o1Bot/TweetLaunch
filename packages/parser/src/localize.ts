import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, logger, requireEnv, xWeightedLength } from "@o1bot/shared";
import { DEFAULT_PARSER_MODEL } from "./parse";

/**
 * Reply templates are written in English; this turns one into the language
 * of the user's post. Anything that must survive verbatim (addresses,
 * handles, tickers, URLs, amounts) is protected by instruction and checked
 * afterwards; on any doubt the English text is used.
 */

const Translated = z.object({ text: z.string().describe("The translated reply, at most 280 characters.") });

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (!cached) cached = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return cached;
}

const PROTECTED = /(0x[0-9a-fA-F]{6,}|@\w{1,15}|\$[A-Z0-9]{1,11}|https?:\/\/\S+|\d+(?:\.\d+)?)/g;

export function isEnglish(language: string | null | undefined): boolean {
  return !language || /^en(?:[-_]|$)/i.test(language.trim());
}

export async function localizeReply(text: string, language: string | null | undefined, opts: { client?: Anthropic; model?: string } = {}): Promise<string> {
  if (isEnglish(language)) return text;
  const model = opts.model ?? env().PARSER_MODEL ?? DEFAULT_PARSER_MODEL;
  try {
    const response = await (opts.client ?? client()).messages.parse({
      model,
      max_tokens: 400,
      ...(/-4-\d/.test(model) ? { temperature: 0 } : {}),
      system:
        `Translate the following reply from a bot on X into the language with BCP-47 tag "${language}". Keep every 0x address, @handle, $TICKER, URL and number exactly as written. Keep it under 280 characters. Plain text, no quotes around it, no explanations.`,
      messages: [{ role: "user", content: text }],
      output_config: { format: zodOutputFormat(Translated) },
    });
    const out = response.parsed_output?.text.trim();
    if (!out || xWeightedLength(out) > 280) return text;
    // Every protected token in the source must still be present.
    for (const token of text.match(PROTECTED) ?? []) if (!out.includes(token)) return text;
    return out;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), language }, "localization failed; using English");
    return text;
  }
}
