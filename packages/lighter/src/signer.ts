// Type bindings for the lighter-go WASM signer — see spikes/wasm-signer/README.md.
//
// The module is built from a pinned lighter-go commit (`just build-wasm`) and registers
// the signing functions as JS globals. The binary is NOT committed; build output goes in
// public/signer/ alongside wasm_exec.js from GOROOT.
//
// Lighter API keys carry full write permission (including trading down to zero) — the
// key lives only in the browser, encrypted, and is never sent to any server.

declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Chain id used for L2 signing on Lighter mainnet. VERIFIED 2026-07-31 from the
 * venue's own signature prompt ("Access Lighter account. Chain ID: 304") during a
 * real deposit. The earlier 4663 was the Robinhood Chain L1 id and would have had
 * every signature rejected here. Override per instance with
 * NEXT_PUBLIC_LIGHTER_L2_CHAIN_ID.
 */
export const L2_CHAIN_ID = Number(
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIGHTER_L2_CHAIN_ID) || 304,
);

/**
 * The API key slot this app registers into (0–255 per Lighter account).
 *
 * A slot holds exactly one key, and `ChangePubKey` on an occupied slot REPLACES
 * what is there. The displaced key stops working immediately, with no error to
 * whoever was using it, so a slot must never be written unless it is ours or
 * known to be free.
 *
 * Measured against a live mainnet account on 2026-09-21 via
 * `/api/v1/apikeys?account_index=…&api_key_index=…`:
 *
 *   slot 0   — occupied; the venue's own frontend registers here (its
 *              "Register Lighter Account" message shows api key index 0)
 *   slot 255 — occupied, carrying the same public key as slot 0; treat as
 *              reserved by the venue
 *   slot 4   — empty (response code 21109)
 *
 * Code 21109 is the venue's "no key in this slot" answer, so occupancy is
 * checkable before writing. Do that before registering a real key: another
 * integrator the user already trusts may hold this slot on their account.
 */
export const API_KEY_INDEX = 4;

export interface GeneratedApiKey {
  privateKey: string;
  publicKey: string;
}

export interface SignedTx {
  txType: number;
  txInfo: string;
  txHash: string;
  /**
   * Present on ChangePubKey / ApproveIntegrator / Transfer: the L1 message the
   * wallet must sign. Merge the resulting signature into txInfo as `L1Sig`
   * before sendTx.
   */
  messageToSign?: string;
}

/** CancelAllOrders time-in-force (lighter-go constants.go). */
export const CANCEL_ALL_TIF = { immediate: 0, scheduled: 1, abort: 2 } as const;

export interface SignerError {
  error: string;
}

export type SignerResult<T> = T | SignerError;

export function isSignerError(r: unknown): r is SignerError {
  return typeof r === "object" && r !== null && "error" in r && Boolean((r as SignerError).error);
}

// Argument order verified against wasm/main.go commit c26ac340 (2026-06-08).
// Other functions (SignCancelOrder, SignWithdraw, etc.) exist in the module but are
// untyped — add them here once their argument order is verified, do not guess.
export interface LighterSignerGlobals {
  GenerateAPIKey(): SignerResult<GeneratedApiKey>;
  CreateClient(
    url: string,
    privateKey: string,
    chainId: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<Record<string, never>>;
  CheckClient(apiKeyIndex: number, accountIndex: number): SignerResult<Record<string, never>>;
  /** Read-only token for the safe tier (portfolio, PnL) — cannot trade / withdraw. */
  CreateAuthToken(
    deadlineUnixSec: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<{ authToken: string }>;
  SignCreateOrder(
    marketIndex: number,
    clientOrderIndex: number,
    baseAmount: number,
    price: number,
    isAsk: 0 | 1,
    orderType: number,
    timeInForce: number,
    reduceOnly: 0 | 1,
    triggerPrice: number,
    /** -1 = default 28 days */
    orderExpiry: number,
    integratorAccountIndex: number,
    /** 1e6 scale: 200 = 2.0 bps */
    integratorTakerFee: number,
    integratorMakerFee: number,
    selfTradeBehaviorMode: number,
    selfTradeEqualityMode: number,
    skipNonce: number,
    /** -1 = fetch nonce from the API; an explicit value = fully offline signing */
    nonce: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<SignedTx>;
  /**
   * Register the API public key on the account (40-byte hex pubKey). The result
   * carries `messageToSign` — have the wallet sign it and merge as `L1Sig` into
   * txInfo before sendTx.
   */
  SignChangePubKey(
    pubKeyHex: string,
    skipNonce: number,
    nonce: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<SignedTx>;
  SignCancelOrder(
    marketIndex: number,
    /** Server-side order index (not the client order index). */
    orderIndex: number,
    skipNonce: number,
    nonce: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<SignedTx>;
  SignCancelAllOrders(
    timeInForce: number,
    timeMs: number,
    /** Limit the sweep to one market id. */
    cancelAllMarketIndex: number,
    skipNonce: number,
    nonce: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<SignedTx>;
  /** Approval = four ceilings (perps/spot × taker/maker) + expiry, not a single value. */
  SignApproveIntegrator(
    integratorAccountIndex: number,
    maxPerpsTakerFee: number,
    maxPerpsMakerFee: number,
    maxSpotTakerFee: number,
    maxSpotMakerFee: number,
    approvalExpiryMs: number,
    skipNonce: number,
    nonce: number,
    apiKeyIndex: number,
    accountIndex: number,
  ): SignerResult<SignedTx>;
}

export interface LoadSignerOptions {
  wasmUrl: string;
  wasmExecUrl: string;
}

let signerPromise: Promise<LighterSignerGlobals> | undefined;

/** Load + instantiate the signer once; subsequent calls reuse the same instance. */
export function loadSigner(opts: LoadSignerOptions): Promise<LighterSignerGlobals> {
  signerPromise ??= instantiate(opts).catch((err) => {
    signerPromise = undefined; // so it can be retried after a failure
    throw err;
  });
  return signerPromise;
}

async function instantiate({ wasmUrl, wasmExecUrl }: LoadSignerOptions): Promise<LighterSignerGlobals> {
  if (typeof window === "undefined") {
    throw new Error("signer only runs in the browser — API keys must never touch a server");
  }

  type GoCtor = new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
  const g = globalThis as typeof globalThis & Record<string, unknown>;

  if (typeof g.Go !== "function") {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = wasmExecUrl;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${wasmExecUrl}`));
      document.head.appendChild(s);
    });
  }

  const go = new (g.Go as GoCtor)();
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
  void go.run(instance); // main() blocks in select{} — globals are available immediately

  for (const name of [
    "GenerateAPIKey",
    "CreateClient",
    "CreateAuthToken",
    "SignCreateOrder",
    "SignChangePubKey",
    "SignCancelAllOrders",
    "SignApproveIntegrator",
  ] as const) {
    if (typeof g[name] !== "function") {
      throw new Error(`signer module does not expose ${name} — wasm built from a different version?`);
    }
  }
  return g as unknown as LighterSignerGlobals;
}
