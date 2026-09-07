import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/mentions.json" with { type: "json" };
import { parseMention } from "../src/parse";

/**
 * Runs the fixtures against the real model. Skipped without an API key so
 * CI stays deterministic; run locally with ANTHROPIC_API_KEY set.
 */

type Expect = {
  kind?: string;
  kindIn?: string[];
  ticker?: string;
  name?: string;
  pair?: string;
  chain?: string | null;
  devBuyNative?: string | null;
  feesToHandle?: string | null;
  missingIncludes?: string[];
  languageStartsWith?: string;
  /** Case-insensitive substrings a help reply must contain. */
  replyIncludes?: string[];
  description?: string | null;
  website?: string | null;
  telegram?: string | null;
  xHandle?: string | null;
};

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasKey)("parser against the live model", () => {
  for (const f of fixtures as Array<{ id: string; text: string; hasImage: boolean; alsoTagged?: string[]; isReply?: boolean; expect: Expect }>) {
    it(f.id, async () => {
      const { result } = await parseMention({ text: f.text, authorHandle: "tester", hasImage: f.hasImage, tweetId: f.id, alsoTagged: f.alsoTagged, isReply: f.isReply });
      const e = f.expect;
      if (e.kind) expect(result.kind).toBe(e.kind);
      if (e.kindIn) expect(e.kindIn).toContain(result.kind);
      if (e.languageStartsWith && "language" in result) expect(result.language.toLowerCase().startsWith(e.languageStartsWith)).toBe(true);
      if (result.kind === "launch") {
        if (e.ticker !== undefined) expect(result.ticker).toBe(e.ticker);
        if (e.name !== undefined) expect(result.name).toBe(e.name);
        if (e.pair !== undefined) expect(result.pair).toBe(e.pair);
        if (e.chain !== undefined) expect(result.chain).toBe(e.chain);
        if (e.devBuyNative !== undefined) expect(result.devBuyNative).toBe(e.devBuyNative);
        if (e.feesToHandle !== undefined) expect(result.feesToHandle).toBe(e.feesToHandle);
        if (e.description !== undefined) expect(result.description).toBe(e.description);
        if (e.website !== undefined) expect(result.website).toBe(e.website);
        if (e.telegram !== undefined) expect(result.telegram).toBe(e.telegram);
        if (e.xHandle !== undefined) expect(result.xHandle).toBe(e.xHandle);
      }
      if (result.kind === "clarify" && e.missingIncludes) {
        for (const m of e.missingIncludes) expect(result.missing).toContain(m);
      }
      if (result.kind === "unsupported_chain" && e.chain !== undefined) expect(result.chain).toBe(e.chain);
      if (result.kind === "help") {
        expect(result.reply.length).toBeLessThanOrEqual(280);
        expect((result.reply.match(/https?:\/\//g) ?? []).length).toBeLessThanOrEqual(1);
        for (const s of e.replyIncludes ?? []) expect(result.reply.toLowerCase()).toContain(s.toLowerCase());
      }
    });
  }
});
