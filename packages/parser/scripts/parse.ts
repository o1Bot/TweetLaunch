/**
 * Parse one mention, or run every fixture, against the live model:
 *
 *   pnpm parse '@o1bot_exchange launch $RUGRAT "Rugrat" pair ETH on robinhood'
 *   pnpm parse --fixtures            # prints a pass/fail table for test/fixtures/mentions.json
 *   pnpm parse --image "text"        # mark the post as having an image attached
 *
 * Needs ANTHROPIC_API_KEY (from the repo .env or the environment).
 */
import "@o1bot/shared/load-env";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseMention } from "../src/parse";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // rely on the environment
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
  allowPositionals: true,
  options: {
    fixtures: { type: "boolean", default: false },
    image: { type: "boolean", default: false },
    model: { type: "string" },
  },
});

const json = (v: unknown) => JSON.stringify(v, null, 2);

if (values.fixtures) {
  type Fixture = { id: string; text: string; hasImage: boolean; expect: Record<string, unknown> };
  const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL("../test/fixtures/mentions.json", import.meta.url)), "utf8")) as Fixture[];
  let pass = 0;
  let totalIn = 0;
  let totalOut = 0;
  let cacheHits = 0;
  for (const f of fixtures) {
    const { result, usage } = await parseMention({ text: f.text, authorHandle: "tester", hasImage: f.hasImage, tweetId: f.id }, { model: values.model });
    totalIn += usage.input + usage.cacheRead + usage.cacheWrite;
    totalOut += usage.output;
    if (usage.cacheRead > 0) cacheHits++;
    const e = f.expect;
    const kindOk = e.kind ? result.kind === e.kind : Array.isArray(e.kindIn) ? (e.kindIn as string[]).includes(result.kind) : true;
    const detail =
      result.kind === "launch"
        ? `${result.ticker} "${result.name}" pair ${result.pair} chain ${result.chain ?? "-"} devbuy ${result.devBuyNative ?? "-"} fees ${result.feesToHandle ?? "-"} [${result.language}]`
        : result.kind === "clarify"
          ? `missing ${result.missing.join(",")}: ${result.question}`
          : result.kind === "help"
            ? result.reply
            : result.kind === "unsupported_chain"
              ? result.chain
              : result.reason;
    if (kindOk) pass++;
    console.log(`${kindOk ? "ok  " : "FAIL"} ${f.id.padEnd(24)} ${result.kind.padEnd(17)} ${detail}`);
  }
  console.log(`\n${pass}/${fixtures.length} fixtures matched on kind · ${totalIn} input tokens, ${totalOut} output tokens, ${cacheHits} cache hits`);
  process.exit(pass === fixtures.length ? 0 : 1);
}

const text = positionals.join(" ").trim();
if (!text) {
  console.error('usage: pnpm parse "<post text>" [--image] | pnpm parse --fixtures');
  process.exit(2);
}
const parsed = await parseMention({ text, authorHandle: "tester", hasImage: values.image }, { model: values.model });
console.log(json(parsed));
