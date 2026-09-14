import { BaseError, ContractFunctionRevertedError } from "viem";

/**
 * Pointing o1's creator fee recipient at a new token right after its launch
 * can hit an RPC node that has not seen the launch block yet: the RPC behind
 * a load balancer answered the receipt from one node and the next call from
 * another. The factory then reverts with UnknownLaunchToken() although the
 * token exists. Three launches on 2026-09-13 lost their fee split this way.
 * The fix is to ask again after a short wait, only for that error.
 */

/** Waits between attempts: about 17 seconds in total, several blocks on every launch chain. */
export const UNKNOWN_TOKEN_RETRY_DELAYS_MS: readonly number[] = [1_500, 3_000, 5_000, 8_000];

/** Whether an error is the factory saying it does not know the token (yet). */
export function isUnknownLaunchToken(err: unknown): boolean {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName === "UnknownLaunchToken") return true;
  }
  return /UnknownLaunchToken/.test(err instanceof Error ? err.message : String(err));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, and run it again after each delay while it fails with
 * UnknownLaunchToken. Any other error, or the last UnknownLaunchToken, is
 * thrown as is.
 */
export async function retryWhileTokenUnknown<T>(
  attempt: () => Promise<T>,
  opts: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (retry: number, delayMs: number) => void } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? UNKNOWN_TOKEN_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? wait;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const delay = delays[i];
      if (delay === undefined || !isUnknownLaunchToken(err)) throw err;
      opts.onRetry?.(i + 1, delay);
      await sleep(delay);
    }
  }
}
