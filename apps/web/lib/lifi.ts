import { getAddress, isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";
import { env } from "@o1bot/shared";
import { CHAIN_IDS, type ChainKey } from "./chains-web";

/**
 * Swaps of tokens that are not o1 launches (stocks, USDG, anything with a
 * pool) go through LI.FI, the router behind jumper.exchange. The site asks
 * LI.FI for a quote, checks every field of the transaction it hands back
 * against what was asked, and only then gives it to the browser to sign
 * with the user's own wallet. The server never signs.
 */

export const LIFI_API = "https://li.quest/v1";
/** The placeholder LI.FI is quoted for when nobody is logged in; such a quote carries no transaction. */
export const NOBODY: Address = "0x000000000000000000000000000000000000dEaD";

/**
 * LI.FI's contract on each chain, its `diamondAddress` in `/v1/chains`
 * (checked 2026-09-17). A quote whose transaction targets anything else is
 * refused, so a compromised upstream could not steer users to another
 * contract.
 */
export const LIFI_DIAMOND: Record<ChainKey, Address> = {
  robinhood: "0xB477751B76CF82d00a686A1232f5fCD772414Af3",
  base: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  arc: "0xA4072583658Fae592A3506A42431cb6316a8d40b",
};

export type LifiQuoteInput = {
  chain: ChainKey;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  /** The wallet that sends and receives; NOBODY for a look-only quote. */
  wallet: Address;
  slippageBps: number;
};

export type LifiQuote = {
  tool: string;
  toolName: string;
  fromAmount: bigint;
  toAmount: bigint;
  toAmountMin: bigint;
  fromAmountUsd: number | null;
  toAmountUsd: number | null;
  gasUsd: number | null;
  feeUsd: number | null;
  executionSeconds: number | null;
  /** Where an ERC-20 input must be approved; null for a native input. */
  approvalAddress: Address | null;
  /** Null for a look-only quote. */
  tx: { to: Address; data: Hex; value: bigint; gasLimit: bigint | null } | null;
};

export class LifiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "LifiError";
  }
}

/** The parts of LI.FI's quote the site reads. */
export type LifiQuoteJson = {
  tool?: string;
  toolDetails?: { name?: string };
  action?: { fromChainId?: number; toChainId?: number; fromToken?: { address?: string; decimals?: number }; toToken?: { address?: string; decimals?: number }; fromAmount?: string; fromAddress?: string; toAddress?: string };
  estimate?: { toAmount?: string; toAmountMin?: string; approvalAddress?: string; executionDuration?: number; fromAmountUSD?: string; toAmountUSD?: string; feeCosts?: Array<{ amountUSD?: string; included?: boolean }>; gasCosts?: Array<{ amountUSD?: string }> };
  transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number; gasLimit?: string };
  message?: string;
  code?: number;
};

const same = (a: string | undefined, b: string): boolean => Boolean(a && isAddress(a, { strict: false }) && getAddress(a.toLowerCase()) === getAddress(b.toLowerCase()));
const num = (v: string | undefined): number | null => (v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * Everything that must hold before a transaction from a third-party API is
 * handed to a wallet. Pure, so the tests can feed it fixtures.
 */
export function checkLifiQuote(q: LifiQuoteJson, input: LifiQuoteInput): string[] {
  const problems: string[] = [];
  const chainId = CHAIN_IDS[input.chain];
  const a = q.action ?? {};
  const e = q.estimate ?? {};
  if (a.fromChainId !== chainId || a.toChainId !== chainId) problems.push(`route is ${a.fromChainId} → ${a.toChainId}, not a swap on chain ${chainId}`);
  if (!same(a.fromToken?.address, input.fromToken)) problems.push(`input token is ${a.fromToken?.address}, expected ${input.fromToken}`);
  if (!same(a.toToken?.address, input.toToken)) problems.push(`output token is ${a.toToken?.address}, expected ${input.toToken}`);
  if (a.fromAmount !== undefined && BigInt(a.fromAmount) !== input.fromAmount) problems.push(`input amount is ${a.fromAmount}, expected ${input.fromAmount}`);
  if (!same(a.fromAddress, input.wallet)) problems.push(`sender is ${a.fromAddress}, expected ${input.wallet}`);
  if (a.toAddress !== undefined && !same(a.toAddress, input.wallet)) problems.push(`recipient is ${a.toAddress}, not the sender`);
  if (!(BigInt(e.toAmountMin ?? "0") > 0n)) problems.push("no minimum output");
  if (BigInt(e.toAmountMin ?? "0") > BigInt(e.toAmount ?? "0")) problems.push("minimum output above the estimate");
  const tx = q.transactionRequest;
  if (input.wallet !== NOBODY) {
    if (!tx) problems.push("no transaction in the quote");
    else {
      if (Number(tx.chainId) !== chainId) problems.push(`transaction is for chain ${tx.chainId}`);
      if (!same(tx.to, LIFI_DIAMOND[input.chain])) problems.push(`transaction targets ${tx.to}, not LI.FI's contract on ${input.chain}`);
      if (!tx.data || !isHex(tx.data)) problems.push("transaction has no calldata");
      const value = BigInt(tx.value ?? "0");
      const nativeIn = getAddress(input.fromToken) === zeroAddress;
      if (nativeIn && value !== input.fromAmount) problems.push(`transaction value ${value} does not match the native amount ${input.fromAmount}`);
      if (!nativeIn && value !== 0n) problems.push(`transaction carries ${value} of native value for an ERC-20 input`);
      if (!nativeIn && !same(e.approvalAddress, LIFI_DIAMOND[input.chain])) problems.push(`approval address ${e.approvalAddress} is not LI.FI's contract`);
    }
  }
  return problems;
}

export function parseLifiQuote(q: LifiQuoteJson, input: LifiQuoteInput): LifiQuote {
  const problems = checkLifiQuote(q, input);
  if (problems.length) throw new LifiError(`LI.FI's quote does not match the request: ${problems.join("; ")}`, 502);
  const e = q.estimate ?? {};
  const tx = q.transactionRequest;
  const nativeIn = getAddress(input.fromToken) === zeroAddress;
  const feeUsd = (e.feeCosts ?? []).filter((f) => !f.included).reduce((sum, f) => sum + (num(f.amountUSD) ?? 0), 0);
  const gasUsd = (e.gasCosts ?? []).reduce((sum, g) => sum + (num(g.amountUSD) ?? 0), 0);
  return {
    tool: q.tool ?? "lifi",
    toolName: q.toolDetails?.name ?? q.tool ?? "LI.FI",
    fromAmount: input.fromAmount,
    toAmount: BigInt(e.toAmount ?? "0"),
    toAmountMin: BigInt(e.toAmountMin ?? "0"),
    fromAmountUsd: num(e.fromAmountUSD),
    toAmountUsd: num(e.toAmountUSD),
    gasUsd: e.gasCosts?.length ? gasUsd : null,
    feeUsd: e.feeCosts?.length ? feeUsd : null,
    executionSeconds: typeof e.executionDuration === "number" ? e.executionDuration : null,
    approvalAddress: nativeIn ? null : getAddress(e.approvalAddress!.toLowerCase()),
    tx: input.wallet === NOBODY || !tx ? null : { to: getAddress(tx.to!.toLowerCase()), data: tx.data as Hex, value: BigInt(tx.value ?? "0"), gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : null },
  };
}

/** A friendlier line for LI.FI's error codes; the raw message otherwise. */
export function describeLifiError(status: number, body: { code?: number; message?: string }): string {
  if (status === 429) return "Too many quotes right now; try again in a moment.";
  if (body.code === 1002) return "No route for this pair right now: nobody offers liquidity for it at this size.";
  if (body.code === 1011) return "This token cannot be swapped here.";
  if (body.code === 1003) return "One of these tokens is unknown to the router.";
  return (body.message ?? `LI.FI answered HTTP ${status}`).slice(0, 160);
}

export async function lifiQuote(input: LifiQuoteInput, fetchImpl: typeof fetch = fetch): Promise<LifiQuote> {
  const e = env();
  const chainId = CHAIN_IDS[input.chain];
  const params = new URLSearchParams({
    fromChain: String(chainId),
    toChain: String(chainId),
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.fromAmount.toString(),
    fromAddress: input.wallet,
    toAddress: input.wallet,
    slippage: String(input.slippageBps / 10_000),
    integrator: e.LIFI_INTEGRATOR,
    order: "RECOMMENDED",
  });
  if (e.LIFI_FEE) params.set("fee", e.LIFI_FEE);
  const res = await fetchImpl(`${LIFI_API}/quote?${params}`, {
    headers: { accept: "application/json", ...(e.LIFI_API_KEY ? { "x-lifi-api-key": e.LIFI_API_KEY } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as LifiQuoteJson;
  if (!res.ok || !json.estimate) throw new LifiError(describeLifiError(res.status, json), res.status, json.code ?? null);
  return parseLifiQuote(json, input);
}
