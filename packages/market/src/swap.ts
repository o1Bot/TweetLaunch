export type SwapSideKind = "BUY" | "SELL";

/**
 * Classify a v4 `Swap` event from the token's point of view. The event's
 * amount0/amount1 are the swapper's balance deltas: negative means the
 * swapper paid that currency into the pool, positive means they received it.
 */
export function classifySwap(input: { amount0: bigint; amount1: bigint; tokenIsCurrency0: boolean }): {
  side: SwapSideKind;
  amountToken: bigint;
  amountQuote: bigint;
} {
  const tokenDelta = input.tokenIsCurrency0 ? input.amount0 : input.amount1;
  const quoteDelta = input.tokenIsCurrency0 ? input.amount1 : input.amount0;
  return {
    side: tokenDelta > 0n ? "BUY" : "SELL",
    amountToken: tokenDelta < 0n ? -tokenDelta : tokenDelta,
    amountQuote: quoteDelta < 0n ? -quoteDelta : quoteDelta,
  };
}

/** Sorted v4 pool key ordering: the lower address is currency0; native ETH (zero) is always currency0. */
export function tokenIsCurrency0(token: string, quote: string): boolean {
  return BigInt(token) < BigInt(quote);
}
