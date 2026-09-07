import { env, logger } from "@o1bot/shared";
import type { Holder, HoldersResult } from "./types";

/**
 * Holder snapshots come from o1's Public API (provider-backed, 10 units per
 * call), cached for 60 seconds per token. Without O1_API_KEY the tab shows
 * "unavailable" rather than a misleading empty list.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: HoldersResult }>();

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function mapHolder(r: Raw): Holder | null {
  const address = str(r.address ?? r.wallet ?? r.holder ?? r.owner);
  if (!address) return null;
  let balance = num(r.balance_formatted ?? r.balance_human ?? r.balance_tokens);
  if (balance === null) {
    const raw = str(r.balance_raw ?? r.balance);
    if (raw && /^\d+$/.test(raw)) balance = raw.length > 18 ? Number(BigInt(raw) / 10n ** 12n) / 1e6 : Number(raw) / 1e18;
    else balance = num(raw);
  }
  const percent = num(r.supply_percent ?? r.percent ?? r.share_percent);
  const label = str(r.label) ?? (r.is_creator === true ? "creator" : null);
  return { address, balance, percent, label };
}

export async function getHolders(token: string): Promise<HoldersResult> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const e = env();
  let value: HoldersResult;
  if (!e.O1_API_KEY) {
    value = { holders: [], total: null, source: "o1", error: "not_configured" };
  } else {
    try {
      const res = await fetch(`${e.O1_API_URL.replace(/\/$/, "")}/tokens/4663/${token}/holders?limit=50`, {
        headers: { "x-api-key": e.O1_API_KEY, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        value = { holders: [], total: null, source: "o1", error: `http_${res.status}` };
      } else {
        const json = (await res.json()) as Raw;
        const rows = (Array.isArray(json.data) ? json.data : Array.isArray(json.holders) ? json.holders : []) as Raw[];
        const summary = (json.summary ?? {}) as Raw;
        value = { holders: rows.map(mapHolder).filter((h): h is Holder => h !== null), total: num(summary.total_holders ?? json.total), source: "o1", error: null };
      }
    } catch (err) {
      logger.warn({ token, err: err instanceof Error ? err.message : String(err) }, "holders fetch failed");
      value = { holders: [], total: null, source: "o1", error: "unreachable" };
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
