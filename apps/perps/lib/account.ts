import type { LighterClient } from "@o1bot/lighter";

/**
 * The standard trading account. Verified live on 2026-09-21: an L1 address can
 * map to MORE THAN ONE Lighter account. 0xbbC93d22…4155 returns two — index 50
 * with `account_type: 0` holding 33.42 collateral, and index 281474976710398
 * with `account_type: 1` holding nothing — while 0x8E327364…7861 returns only
 * the type-0 one.
 *
 * So `accounts[0]` is not the answer. It happened to be right in both samples,
 * and the API makes no ordering promise, so relying on it would put orders on
 * whichever account the venue listed first. Select on the type instead.
 *
 * What type 1 actually is has not been established — only that it is not the
 * account carrying collateral in either sample. If one ever needs to be
 * offered, find out what it is first rather than widening this filter.
 */
export const STANDARD_ACCOUNT_TYPE = 0;

export interface TradingAccount {
  index: number;
  collateral: number;
  availableBalance: number;
  totalAssetValue: number;
}

interface RawAccount {
  account_index?: number;
  account_type?: number;
  collateral?: string | number;
  available_balance?: string | number;
  total_asset_value?: string | number;
}

function num(v: string | number | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
}

export function pickTradingAccount(accounts: readonly RawAccount[]): TradingAccount | null {
  const a = accounts.find((x) => x.account_type === STANDARD_ACCOUNT_TYPE);
  if (!a || typeof a.account_index !== "number") return null;
  return {
    index: a.account_index,
    collateral: num(a.collateral),
    availableBalance: num(a.available_balance),
    totalAssetValue: num(a.total_asset_value),
  };
}

export type LinkStatus =
  | { state: "none" }
  | { state: "linked"; account: TradingAccount }
  /** Accounts exist for the address but none is a standard trading account. */
  | { state: "unusable"; types: number[] }
  | { state: "error"; message: string };

/**
 * An address with no Lighter account is the normal first-time case, not a
 * failure: the venue answers HTTP 400 with code 21100 and the client turns that
 * into null.
 */
export async function lookupAccount(client: LighterClient, address: string): Promise<LinkStatus> {
  try {
    const res = await client.accountByL1Address(address);
    if (!res) return { state: "none" };
    const accounts = ((res as { accounts?: RawAccount[] }).accounts ?? []) as RawAccount[];
    if (accounts.length === 0) return { state: "none" };
    const account = pickTradingAccount(accounts);
    if (!account) {
      return { state: "unusable", types: accounts.map((a) => a.account_type ?? -1) };
    }
    return { state: "linked", account };
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : "lookup failed" };
  }
}
