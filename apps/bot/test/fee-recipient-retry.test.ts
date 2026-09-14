import { BaseError, ContractFunctionRevertedError, encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { isUnknownLaunchToken, retryWhileTokenUnknown } from "../src/fee-recipient-retry";

const abi = parseAbi(["error UnknownLaunchToken()", "error NotCreator()", "function setCreatorFeeRecipient(address token, address recipient)"]);
const reverted = (errorName: "UnknownLaunchToken" | "NotCreator") =>
  new BaseError("The contract function \"setCreatorFeeRecipient\" reverted.", {
    cause: new ContractFunctionRevertedError({ abi, functionName: "setCreatorFeeRecipient", data: encodeErrorResult({ abi, errorName }) }),
  });

describe("recognising the factory's unknown-token revert", () => {
  it("finds it in a decoded revert and in a plain message", () => {
    expect(isUnknownLaunchToken(reverted("UnknownLaunchToken"))).toBe(true);
    expect(isUnknownLaunchToken(new Error('The contract function "setCreatorFeeRecipient" reverted. Error: UnknownLaunchToken()'))).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isUnknownLaunchToken(reverted("NotCreator"))).toBe(false);
    expect(isUnknownLaunchToken(new Error("nonce too low"))).toBe(false);
  });
});

describe("retrying while the token is unknown", () => {
  const noSleep = { sleep: async () => {} };

  it("succeeds once a lagging node catches up, waiting the given delays", async () => {
    const waited: number[] = [];
    let calls = 0;
    const result = await retryWhileTokenUnknown(
      async () => {
        calls++;
        if (calls < 3) throw reverted("UnknownLaunchToken");
        return "0xhash";
      },
      { delaysMs: [10, 20, 30], sleep: async (ms) => void waited.push(ms) },
    );
    expect(result).toBe("0xhash");
    expect(calls).toBe(3);
    expect(waited).toEqual([10, 20]);
  });

  it("gives up after the last delay with the original error", async () => {
    let calls = 0;
    const err = reverted("UnknownLaunchToken");
    await expect(
      retryWhileTokenUnknown(
        async () => {
          calls++;
          throw err;
        },
        { delaysMs: [1, 1], ...noSleep },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(3);
  });

  it("does not retry any other error", async () => {
    let calls = 0;
    await expect(
      retryWhileTokenUnknown(
        async () => {
          calls++;
          throw reverted("NotCreator");
        },
        { delaysMs: [1, 1, 1], ...noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
