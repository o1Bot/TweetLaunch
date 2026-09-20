import type {
  AccountLookupResponse,
  CandleResolution,
  CandlesResponse,
  FundingsResponse,
  OrderBookDetailsResponse,
  OrderBooksResponse,
  RecentTradesResponse,
  SendTxResponse,
  SystemConfig,
} from "./types";

declare const process: { env: Record<string, string | undefined> } | undefined;

// Default instance: Lighter MAINNET (product decision 2026-07-29 — RWA narrative +
// deep liquidity). The RH instance can still be used via NEXT_PUBLIC_LIGHTER_API.
export const DEFAULT_BASE_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIGHTER_API) ||
  "https://mainnet.zklighter.elliot.ai";

export class LighterHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `lighter api ${status} at ${path}`);
    this.name = "LighterHttpError";
  }
}

export interface LighterClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createLighterClient(opts: LighterClientOptions = {}) {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function get<T extends { code: number }>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, init);
    if (!res.ok) throw new LighterHttpError(res.status, path);
    const body = (await res.json()) as T;
    // The API returns HTTP 200 with an error `code` in the body — both must be checked.
    if (body.code !== 200) {
      throw new LighterHttpError(body.code, path, `lighter api code ${body.code} at ${path}`);
    }
    return body;
  }

  return {
    orderBooks: (init?: RequestInit) => get<OrderBooksResponse>("/api/v1/orderBooks", init),
    orderBookDetails: (init?: RequestInit) =>
      get<OrderBookDetailsResponse>("/api/v1/orderBookDetails", init),
    systemConfig: (init?: RequestInit) => get<SystemConfig>("/api/v1/systemConfig", init),
    /** Per-asset metadata incl. index price — needed to value balances honestly. */
    assetDetails: (init?: RequestInit) =>
      get<{
        code: number;
        asset_details: {
          asset_id: number;
          symbol: string;
          index_price: string;
          decimals: number;
        }[];
      }>("/api/v1/assetDetails", init),
    /** Maximum `limit` the API accepts is 100 (verified live — anything above returns 400). */
    recentTrades: (marketId: number, limit = 100, init?: RequestInit) =>
      get<RecentTradesResponse>(
        `/api/v1/recentTrades?market_id=${marketId}&limit=${limit}`,
        init,
      ),
    /**
     * Native OHLCV candles — the /candles endpoint, not /candlesticks (that one 403s).
     * Timestamps in MILLISECONDS. Max 500 bars per call.
     */
    candles: (
      marketId: number,
      resolution: CandleResolution,
      startMs: number,
      endMs: number,
      countBack = 500,
      init?: RequestInit,
    ) =>
      get<CandlesResponse>(
        `/api/v1/candles?market_id=${marketId}&resolution=${resolution}` +
          `&start_timestamp=${startMs}&end_timestamp=${endMs}&count_back=${countBack}&optimize=true`,
        init,
      ),
    /**
     * Funding history per perp market. Verified live: resolutions "1h" and "1d",
     * lookback up to 30 days (720 1h points). The start/end params are REQUIRED.
     */
    fundings: (
      marketId: number,
      resolution: "1h" | "1d",
      startSec: number,
      endSec: number,
      countBack: number,
      init?: RequestInit,
    ) =>
      get<FundingsResponse>(
        `/api/v1/fundings?market_id=${marketId}&resolution=${resolution}` +
          `&start_timestamp=${startSec}&end_timestamp=${endSec}&count_back=${countBack}`,
        init,
      ),
    /**
     * Is an API key registered in this slot? `null` = not registered (the venue
     * answers code 21109). Definitive check — CheckClient in the WASM signer can
     * also fail for transport reasons.
     */
    apiKey: async (
      accountIndex: number,
      apiKeyIndex: number,
      init?: RequestInit,
    ): Promise<{ public_key: string; nonce: number } | null> => {
      const res = await doFetch(
        `${base}/api/v1/apikeys?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`,
        init,
      );
      const body = (await res.json().catch(() => null)) as {
        code?: number;
        api_keys?: { public_key: string; nonce: number }[];
      } | null;
      if (body?.code === 200) return body.api_keys?.[0] ?? null;
      if (body?.code === 21109) return null;
      throw new LighterHttpError(body?.code ?? res.status, "/api/v1/apikeys");
    },
    /**
     * REST order book snapshot (the WebSocket stream is the live path; this is
     * for one-shot reads such as an agent asking about depth).
     */
    orderBook: async (marketId: number, limit = 25, init?: RequestInit) => {
      const body = await get<{
        code: number;
        asks?: { price: string; remaining_base_amount: string }[];
        bids?: { price: string; remaining_base_amount: string }[];
      }>(`/api/v1/orderBookOrders?market_id=${marketId}&limit=${limit}`, init);
      // Aggregate resting orders into price levels, best first.
      const level = (rows: { price: string; remaining_base_amount: string }[], desc: boolean) => {
        const byPrice = new Map<string, number>();
        for (const r of rows) {
          byPrice.set(r.price, (byPrice.get(r.price) ?? 0) + Number(r.remaining_base_amount));
        }
        return [...byPrice.entries()]
          .map(([price, size]) => ({ price, size: String(size) }))
          .sort((a, b) => (desc ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price)));
      };
      return {
        asks: level(body.asks ?? [], false),
        bids: level(body.bids ?? [], true),
      };
    },
    /** Look up an account by its venue index. */
    accountByIndex: async (index: number, init?: RequestInit) => {
      const res = await doFetch(`${base}/api/v1/account?by=index&value=${index}`, init);
      const body = (await res.json().catch(() => null)) as AccountLookupResponse | null;
      if (body?.code === 200) return body;
      if (body?.code === 21100) return null;
      throw new LighterHttpError(body?.code ?? res.status, "/api/v1/account");
    },
    /** Next nonce for the (account, api key) pair — required before signing offline. */
    nextNonce: (accountIndex: number, apiKeyIndex: number, init?: RequestInit) =>
      get<{ code: number; nonce: number }>(
        `/api/v1/nextNonce?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`,
        init,
      ),
    /**
     * Send an already-signed tx. Form-encoded `tx_type` + `tx_info` (JSON string) —
     * shape verified live (an empty POST gets a validation error, not a 404).
     * Success response shape not yet verified without a real account.
     */
    sendTx: async (
      txType: number,
      txInfo: string,
      init?: RequestInit,
    ): Promise<SendTxResponse> => {
      const res = await doFetch(`${base}/api/v1/sendTx`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tx_type: String(txType), tx_info: txInfo }).toString(),
        ...init,
      });
      const body = (await res.json().catch(() => null)) as SendTxResponse | null;
      if (!body || body.code !== 200) {
        throw new LighterHttpError(
          body?.code ?? res.status,
          "/api/v1/sendTx",
          body?.message ? `sendTx rejected: ${body.message}` : undefined,
        );
      }
      return body;
    },
    /**
     * Look up a Lighter account by L1 address. `null` = this address has no account
     * yet (the API responds HTTP 400 + code 21100 — not an error for us).
     */
    accountByL1Address: async (
      address: string,
      init?: RequestInit,
    ): Promise<AccountLookupResponse | null> => {
      const res = await doFetch(
        `${base}/api/v1/account?by=l1_address&value=${address}`,
        init,
      );
      const body = (await res.json().catch(() => null)) as AccountLookupResponse | null;
      if (body?.code === 200) return body;
      if (body?.code === 21100) return null;
      throw new LighterHttpError(body?.code ?? res.status, "/api/v1/account");
    },
  };
}

export type LighterClient = ReturnType<typeof createLighterClient>;
