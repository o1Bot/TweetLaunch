import { BaseError, ContractFunctionRevertedError, InsufficientFundsError } from "viem";

/**
 * Map anything thrown by simulation / broadcast to a small, stable set of
 * kinds the validator, replier and logs can act on. Names come from the
 * verified factory ABI (see abis/LaunchFactory.*.json → `error` items).
 */
export const LAUNCH_ERROR_KINDS = [
  "stale_config",
  "expired",
  "pair_not_registered",
  "creation_disabled",
  "bad_suffix",
  "salt_used",
  "bad_payment",
  "bad_token_fields",
  "dev_buy_rejected",
  "dev_buy_no_route",
  "token_check_failed",
  "config_error",
  "insufficient_balance",
  "ticker_collides_with_stock",
  "registry_drift",
  "unknown_revert",
  "rpc_error",
  "unknown",
] as const;
export type LaunchErrorKind = (typeof LAUNCH_ERROR_KINDS)[number];

export type LaunchError = {
  kind: LaunchErrorKind;
  message: string;
  /** Solidity custom error name when the failure was a revert. */
  errorName?: string;
  args?: readonly unknown[];
};

/** Which kinds are worth an automatic retry with fresh reads. */
export const RETRYABLE_KINDS: ReadonlySet<LaunchErrorKind> = new Set(["stale_config", "expired", "salt_used", "rpc_error"]);

const BY_ERROR_NAME: Record<string, LaunchErrorKind> = {
  StaleConfig: "stale_config",
  LaunchExpired: "expired",
  QuoteNotRegistered: "pair_not_registered",
  LaunchCreationDisabled: "creation_disabled",
  InvalidTokenAddressSuffix: "bad_suffix",
  LaunchSaltUsed: "salt_used",
  InvalidNativeLaunchFeePayment: "bad_payment",
  InvalidLaunchBuyPayment: "bad_payment",
  EmptyTokenNameOrSymbol: "bad_token_fields",
  InvalidLaunchBuyParams: "dev_buy_rejected",
  LaunchBuyAdapterNotConfigured: "dev_buy_rejected",
  NotImmutable: "token_check_failed",
  TokenMismatch: "token_check_failed",
  OutOfBounds: "config_error",
  InvalidConfig: "config_error",
  MisalignedStartTick: "config_error",
  MisalignedOffset: "config_error",
  ReentrancyGuardReentrantCall: "config_error",
  NotSingleSided: "config_error",
};

/**
 * Errors raised by contracts we cannot decode with a vendored ABI (the
 * launch-buy adapter and its router are not source-verified). Selectors were
 * resolved through the openchain signature database on 2026-09-07.
 */
const BY_RAW_SELECTOR: Record<string, { errorName: string; kind: LaunchErrorKind; hint: string }> = {
  "0x54090af9": {
    errorName: "DeadlineTooLong",
    kind: "dev_buy_rejected",
    hint: "the launch-buy adapter rejects long deadlines; use a few minutes when a dev buy is attached",
  },
  "0x5d5fe824": {
    errorName: "UnsupportedRoute",
    kind: "dev_buy_rejected",
    hint: "the launch-buy adapter refused this route shape (for example native ETH straight into a non-launch V4 pool)",
  },
};

export function classifyError(err: unknown): LaunchError {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const errorName = reverted?.data?.errorName;
    if (errorName) {
      return {
        kind: BY_ERROR_NAME[errorName] ?? "unknown_revert",
        message: reverted?.shortMessage ?? err.shortMessage,
        errorName,
        args: reverted?.data?.args,
      };
    }
    const raw = reverted?.signature?.toLowerCase();
    const known = raw ? BY_RAW_SELECTOR[raw] : undefined;
    if (known) {
      return { kind: known.kind, message: `${known.errorName}(): ${known.hint}`, errorName: known.errorName };
    }
    if (reverted) return { kind: "unknown_revert", message: reverted.shortMessage, errorName: raw };
    if (err.walk((e) => e instanceof InsufficientFundsError) || /insufficient funds/i.test(err.message)) {
      return { kind: "insufficient_balance", message: err.shortMessage };
    }
    if (/execution reverted/i.test(err.message)) return { kind: "unknown_revert", message: err.shortMessage };
    return { kind: "rpc_error", message: err.shortMessage };
  }
  if (err instanceof Error) {
    if (/insufficient funds/i.test(err.message)) return { kind: "insufficient_balance", message: err.message };
    return { kind: "unknown", message: err.message };
  }
  return { kind: "unknown", message: String(err) };
}
