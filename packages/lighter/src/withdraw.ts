import { DEPOSIT_ROUTE, USDC_ASSET_ID, USDC_DECIMALS, type DepositRoute } from "./deposit";

/**
 * Withdrawing collateral back to Ethereum: the secure route.
 *
 * An L2 withdraw is signed with the account's API key, like an order, and the
 * venue pays it out to the L1 address that owns the account. There is no
 * destination field to get wrong, and no key this app holds could send the
 * money anywhere else. Observed on mainnet: about 23 minutes, no venue fee,
 * minimum 1 USDC. The fast route (15–20 s, lands on Arbitrum, ~$3 fee) needs
 * a signature from the Ethereum key over a message this repo has not
 * verified, so it is not offered.
 *
 * Verified against lighter-go commit c26ac340: `SignWithdraw(assetIndex,
 * routeType, amount, skipNonce, nonce, apiKeyIndex, accountIndex)`,
 * `TxTypeL2Withdraw = 13`, `USDCAssetIndex = 3`, `AssetRouteType_Perps = 0`,
 * amount a uint64 in the asset's own units (`OneUSDC = 1_000_000`).
 *
 * This module only describes the transaction; it never holds keys.
 */

export const TX_TYPE_L2_WITHDRAW = 13;

/** The venue pays out nothing smaller. */
export const MIN_WITHDRAW_USDC = 1;

/** Observed on mainnet, not a promise the venue makes. */
export const SECURE_WITHDRAW_MINUTES = 23;

export interface WithdrawInput {
  /** As typed, e.g. "12.5". A string on purpose: a float cannot be trusted to hold a payout amount exactly. */
  amountUsdc: string;
  /** The venue's available balance for the account, in USDC: collateral not backing a position. */
  availableUsdc: number;
  route?: DepositRoute;
}

export interface BuiltWithdraw {
  assetIndex: number;
  routeType: number;
  /** uint64, in 1e-6 USDC — exactly what SignWithdraw takes. */
  amount: number;
  /** The payout as the venue will make it, normalised: "12.5" → "12.500000". */
  amountUsdc: string;
}

export class WithdrawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WithdrawError";
  }
}

const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** A decimal USDC string as integer units, refusing anything the asset cannot represent exactly. */
export function usdcUnits(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m) throw new WithdrawError("enter an amount in USDC, digits only");
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) {
    throw new WithdrawError(`USDC has ${USDC_DECIMALS} decimals; "${amount.trim()}" has more`);
  }
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** Integer units back to a decimal string with all six places, for display and receipts. */
export function formatUsdcUnits(units: bigint): string {
  return `${units / UNIT}.${(units % UNIT).toString().padStart(USDC_DECIMALS, "0")}`;
}

export function buildWithdraw(i: WithdrawInput): BuiltWithdraw {
  const units = usdcUnits(i.amountUsdc);
  if (units < BigInt(MIN_WITHDRAW_USDC) * UNIT) {
    throw new WithdrawError(`the venue pays out at least ${MIN_WITHDRAW_USDC} USDC`);
  }
  if (!Number.isFinite(i.availableUsdc) || i.availableUsdc < 0) {
    throw new WithdrawError("the available balance is not known yet");
  }
  // The balance arrives as a float. Flooring it to units before comparing
  // means 10.0000004 available allows 10.000000 and never 10.000001 — the
  // venue would reject the latter anyway, but this is where it should fail.
  const available = BigInt(Math.floor(i.availableUsdc * Number(UNIT)));
  if (units > available) {
    throw new WithdrawError("more than the available balance — margin backing a position cannot be withdrawn");
  }
  // The signer takes a JS number; beyond 2^53 units it would silently lose
  // digits, and a payout is the wrong place for that.
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WithdrawError("amount too large to pass to the signer exactly");
  }
  return {
    assetIndex: USDC_ASSET_ID,
    routeType: DEPOSIT_ROUTE[i.route ?? "perps"],
    amount: Number(units),
    amountUsdc: formatUsdcUnits(units),
  };
}
