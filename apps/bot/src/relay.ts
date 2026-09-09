import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isHex, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { env, logger, RELAY_DEPOSITORY } from "@o1bot/shared";

/**
 * Relay (relay.link) moves ETH between chains in seconds: the user sends a
 * deposit to Relay's depository on the origin chain, a solver pays out on
 * Robinhood. The bot only ever asks for a quote whose recipient is the
 * user's own wallet, signs the one deposit the quote describes, and polls
 * the request until it is filled.
 *
 * The depository's `depositNative(address depositor, bytes32 id)` credits
 * `depositor`, or `msg.sender` when it is the zero address. The bot always
 * encodes the zero address, so the credited party is structurally the
 * signing wallet: the enclave policy pins that argument to zero, and a
 * leaked key could only ever deposit on the wallet's own behalf.
 */

export type RelayQuote = {
  /** Relay's request id, for status polling. */
  requestId: Hex;
  /** The bytes32 Relay put in the deposit calldata; the allow-list pins it. */
  depositId: Hex;
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  /** ETH expected on Robinhood, after Relay's fee. */
  amountOut: bigint;
  /** Relay's estimate, in seconds. */
  timeEstimate: number;
};

export type RelayStatus = { status: "waiting" | "pending" | "delayed" | "success" | "failure" | "refund" | "unknown"; fillTxHash: Hex | null };

export type RelayClient = {
  quote(input: { user: Address; originChainId: number; destinationChainId: number; amountWei: bigint }): Promise<RelayQuote>;
  status(requestId: Hex): Promise<RelayStatus>;
};

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

const NATIVE = "0x0000000000000000000000000000000000000000";
export const relayDepositAbi = parseAbi(["function depositNative(address to, bytes32 id)"]);

type QuoteJson = {
  steps?: Array<{ id?: string; kind?: string; requestId?: string; items?: Array<{ data?: { to?: string; data?: string; value?: string; chainId?: number }; check?: { endpoint?: string } }> }>;
  details?: { currencyOut?: { amount?: string }; timeEstimate?: number };
  message?: string;
};

export function liveRelay(fetchImpl: typeof fetch = fetch): RelayClient {
  const e = env();
  const base = e.RELAY_API_URL.replace(/\/$/, "");
  // Quotes need no key. A key (from Relay's app registration) attributes volume to o1bot and unlocks fee sharing.
  const headers: Record<string, string> = { "content-type": "application/json", ...(e.RELAY_API_KEY ? { "x-api-key": e.RELAY_API_KEY } : {}) };
  return {
    async quote(input) {
      const res = await fetchImpl(`${base}/quote`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          user: input.user,
          recipient: input.user,
          originChainId: input.originChainId,
          destinationChainId: input.destinationChainId,
          originCurrency: NATIVE,
          destinationCurrency: NATIVE,
          amount: input.amountWei.toString(),
          tradeType: "EXACT_INPUT",
          ...(e.RELAY_API_KEY ? { referrer: "o1bot.exchange" } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => ({}))) as QuoteJson;
      if (!res.ok) throw new RelayError(`relay quote HTTP ${res.status}: ${(json.message ?? "").slice(0, 160)}`, res.status);
      const steps = json.steps ?? [];
      const item = steps[0]?.items?.[0];
      // Exactly one deposit transaction; anything else is a flow the bot does not sign.
      if (steps.length !== 1 || steps[0]!.kind !== "transaction" || (steps[0]!.items?.length ?? 0) !== 1 || !item?.data) throw new RelayError("relay quote is not a single deposit transaction", res.status);
      const requestId = steps[0]!.requestId ?? item.check?.endpoint?.match(/requestId=(0x[0-9a-fA-F]{64})/)?.[1];
      const { to, data, value, chainId } = item.data;
      if (!requestId || !isHex(requestId) || !to || !isAddress(to) || !data || !isHex(data) || value === undefined || chainId !== input.originChainId) {
        throw new RelayError("relay quote is missing the deposit details", res.status);
      }
      const amountOut = BigInt(json.details?.currencyOut?.amount ?? "0");
      if (amountOut <= 0n) throw new RelayError("relay quote has no output amount", res.status);
      // The deposit must be depositNative(user, id). The bot re-encodes it with the zero depositor
      // (msg.sender in the contract), which credits the same wallet without naming it in calldata.
      let depositId: Hex;
      try {
        const decoded = decodeFunctionData({ abi: relayDepositAbi, data: data as Hex });
        const [depositTo, id] = decoded.args;
        if (getAddress(depositTo) !== getAddress(input.user)) throw new Error("deposit names another wallet");
        depositId = id;
      } catch (err) {
        throw new RelayError(`relay deposit calldata is not depositNative for this wallet: ${err instanceof Error ? err.message : String(err)}`, res.status);
      }
      const ownData = encodeFunctionData({ abi: relayDepositAbi, functionName: "depositNative", args: [zeroAddress, depositId] });
      const quote: RelayQuote = { requestId: requestId as Hex, depositId, chainId, to: getAddress(to), data: ownData, value: BigInt(value), amountOut, timeEstimate: json.details?.timeEstimate ?? 0 };
      if (quote.to !== RELAY_DEPOSITORY) logger.warn({ to: quote.to, expected: RELAY_DEPOSITORY }, "relay quote points at an unknown depository; the allow-list will refuse it");
      return quote;
    },

    async status(requestId) {
      const res = await fetchImpl(`${base}/intents/status?requestId=${requestId}`, { headers, signal: AbortSignal.timeout(15_000) });
      const json = (await res.json().catch(() => ({}))) as { status?: string; txHashes?: string[] };
      const raw = (json.status ?? "unknown").toLowerCase();
      const status = (["waiting", "pending", "delayed", "success", "failure", "refund"] as const).find((s) => s === raw) ?? "unknown";
      const fill = (json.txHashes ?? []).find((h) => isHex(h)) ?? null;
      return { status, fillTxHash: fill as Hex | null };
    },
  };
}
