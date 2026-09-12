import { BaseError } from "viem";
import { describe, expect, it } from "vitest";
import { classifyError, RETRYABLE_KINDS } from "../src/errors";

describe("a signing refused by the Privy policy", () => {
  it("is its own kind, not an RPC failure, and is not retried", () => {
    const viemErr = new BaseError("An unknown error occurred while executing the contract function", { details: "RPC request denied due to policy violation" });
    expect(classifyError(viemErr).kind).toBe("policy_denied");
    expect(classifyError(new Error("RPC request denied due to policy violation")).kind).toBe("policy_denied");
    expect(RETRYABLE_KINDS.has("policy_denied")).toBe(false);
  });

  it("leaves other transport failures as RPC errors", () => {
    expect(classifyError(new BaseError("HTTP request failed", { details: "timeout" })).kind).toBe("rpc_error");
  });
});
