import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { launchFactoryAbi } from "../src/abis";
import { classifyError, RETRYABLE_KINDS } from "../src/errors";

/** viem wraps this in ContractFunctionExecutionError; classifyError walks to it either way. */
function revert(errorName: "StaleConfig" | "LaunchSaltUsed" | "QuoteNotRegistered", args: readonly unknown[]) {
  const data = encodeErrorResult({ abi: launchFactoryAbi, errorName, args: args as never });
  const reverted = new ContractFunctionRevertedError({ abi: launchFactoryAbi, functionName: "createLaunch", data });
  return new BaseError("simulation failed", { cause: reverted });
}

describe("classifyError", () => {
  it("maps factory custom errors to stable kinds with decoded args", () => {
    const stale = classifyError(revert("StaleConfig", [13n, 14n]));
    expect(stale.kind).toBe("stale_config");
    expect(stale.errorName).toBe("StaleConfig");
    expect(stale.args).toEqual([13n, 14n]);
    expect(RETRYABLE_KINDS.has(stale.kind)).toBe(true);

    expect(classifyError(revert("LaunchSaltUsed", [`0x${"ab".repeat(32)}`])).kind).toBe("salt_used");
    expect(classifyError(revert("QuoteNotRegistered", [])).kind).toBe("pair_not_registered");
  });

  it("recognises insufficient funds and generic failures", () => {
    expect(classifyError(new Error("insufficient funds for gas * price + value")).kind).toBe("insufficient_balance");
    expect(classifyError(new BaseError("HTTP request failed.")).kind).toBe("rpc_error");
    expect(classifyError("boom").kind).toBe("unknown");
  });
});
