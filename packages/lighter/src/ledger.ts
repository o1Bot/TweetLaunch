// Cost ledger math — the product's signature element: the whole price of an
// order, shown and current before the order can be submitted.
//
// Every function is pure: numbers in, numbers out, no state — so the rendered
// ledger and the submitted order can never disagree (disagreement = P0). Fee
// values are in ppm (1e6 scale, 200 = 2.0 bps), exactly as sent to the signer.

// 2.0 bps — a starting value, under the measured systemConfig ceilings (perps
// 10 bps, spot 100 bps). The rate this product charges is not decided yet;
// read the live ceiling from systemConfig and never hardcode it there.
export const DEFAULT_TAKER_FEE_PPM = 200;
// Free on purpose — acquisition. The plumbing carries it anyway so turning it
// on later is a config change, not a broken promise.
export const DEFAULT_MAKER_FEE_PPM = 0;

export interface PerpLedgerInput {
  side: "long" | "short";
  /** Position notional in quote units (USD). */
  notionalUsd: number;
  /** Entry price the user is working with (limit) or mid (market). */
  entryPrice: number;
  leverage: number;
  /** true = an order that will match immediately (market / crossing limit). */
  isTaker: boolean;
  /** bps, from orderBookDetails.maintenance_margin_fraction. */
  maintenanceMarginBps: number;
  /**
   * current_funding_rate from market_stats, in percent (e.g. "0.0012").
   * NOTE: the time basis of this rate is not yet verified against the docs —
   * the ledger row is labelled "est." until the unit is confirmed.
   */
  fundingRatePct?: number;
  /** Fee overrides (ppm). Defaults to the constants above; 0 while the integrator is off. */
  takerFeePpm?: number;
  makerFeePpm?: number;
}

export interface PerpLedger {
  notionalUsd: number;
  marginUsd: number;
  /** Base size (contracts) — not yet rounded to the market's size decimals. */
  contracts: number;
  lighterFeeUsd: number;
  integratorFeeUsd: number;
  integratorFeePpm: number;
  estFunding8hUsd: number;
  liqPrice: number;
  /** Margin + fees — what leaves the balance when the order goes in. */
  totalDebitedUsd: number;
}

export function perpLedger(i: PerpLedgerInput): PerpLedger {
  const feePpm = i.isTaker
    ? (i.takerFeePpm ?? DEFAULT_TAKER_FEE_PPM)
    : (i.makerFeePpm ?? DEFAULT_MAKER_FEE_PPM);
  if (i.notionalUsd <= 0 || i.entryPrice <= 0 || i.leverage <= 0) {
    return {
      notionalUsd: 0,
      marginUsd: 0,
      contracts: 0,
      lighterFeeUsd: 0,
      integratorFeeUsd: 0,
      integratorFeePpm: feePpm,
      estFunding8hUsd: 0,
      liqPrice: 0,
      totalDebitedUsd: 0,
    };
  }
  const integratorFeeUsd = (i.notionalUsd * feePpm) / 1_000_000;
  const marginUsd = i.notionalUsd / i.leverage;
  const contracts = i.notionalUsd / i.entryPrice;
  const estFunding8hUsd = ((i.fundingRatePct ?? 0) / 100) * i.notionalUsd;
  const mmf = i.maintenanceMarginBps / 10_000;
  // Simple single-position cross estimate: distance to liquidation = initial margin
  // minus the maintenance buffer. The final number belongs to Lighter's risk engine —
  // this is a labelled estimate.
  const liqPrice =
    i.side === "long"
      ? i.entryPrice * (1 - 1 / i.leverage + mmf)
      : i.entryPrice * (1 + 1 / i.leverage - mmf);
  return {
    notionalUsd: i.notionalUsd,
    marginUsd,
    contracts,
    lighterFeeUsd: 0, // retail zero on every book — verified live (api-truth §5)
    integratorFeeUsd,
    integratorFeePpm: feePpm,
    estFunding8hUsd,
    liqPrice,
    totalDebitedUsd: marginUsd + integratorFeeUsd,
  };
}

export interface SpotLedgerInput {
  side: "buy" | "sell";
  /** Quote amount (USD) to spend / receive. */
  notionalUsd: number;
  /** The user's limit price. */
  limitPrice: number;
  /** Current book mid — for the distance in bps. */
  midPrice?: number;
  isTaker: boolean;
  /** Fee overrides (ppm). Defaults to the constants above; 0 while the integrator is off. */
  takerFeePpm?: number;
  makerFeePpm?: number;
}

export interface SpotLedger {
  youPayUsd: number;
  youReceiveBase: number;
  fillPrice: number;
  /** Distance of the limit from mid in bps; positive = above mid (buy side). */
  distanceFromMidBps: number | null;
  lighterFeeUsd: number;
  integratorFeeUsd: number;
  integratorFeePpm: number;
  /** Buy: quote debit. Sell: quote credit (positive). */
  totalUsd: number;
}

export function spotLedger(i: SpotLedgerInput): SpotLedger {
  const feePpm = i.isTaker
    ? (i.takerFeePpm ?? DEFAULT_TAKER_FEE_PPM)
    : (i.makerFeePpm ?? DEFAULT_MAKER_FEE_PPM);
  if (i.notionalUsd <= 0 || i.limitPrice <= 0) {
    return {
      youPayUsd: 0,
      youReceiveBase: 0,
      fillPrice: i.limitPrice > 0 ? i.limitPrice : 0,
      distanceFromMidBps: null,
      lighterFeeUsd: 0,
      integratorFeeUsd: 0,
      integratorFeePpm: feePpm,
      totalUsd: 0,
    };
  }
  const integratorFeeUsd = (i.notionalUsd * feePpm) / 1_000_000;
  const base = i.notionalUsd / i.limitPrice;
  const distanceFromMidBps =
    i.midPrice && i.midPrice > 0 ? ((i.limitPrice - i.midPrice) / i.midPrice) * 10_000 : null;
  return {
    youPayUsd: i.side === "buy" ? i.notionalUsd + integratorFeeUsd : 0,
    youReceiveBase: i.side === "buy" ? base : -base,
    fillPrice: i.limitPrice,
    distanceFromMidBps,
    lighterFeeUsd: 0,
    integratorFeeUsd,
    integratorFeePpm: feePpm,
    totalUsd: i.side === "buy" ? -(i.notionalUsd + integratorFeeUsd) : i.notionalUsd - integratorFeeUsd,
  };
}
