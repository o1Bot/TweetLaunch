import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { checkLifiQuote, describeLifiError, LIFI_DIAMOND, NOBODY, parseLifiQuote, type LifiQuoteInput, type LifiQuoteJson } from "../lib/lifi";

const WALLET = "0x1111111111111111111111111111111111111111";
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";

/** The shape LI.FI answered on 2026-09-17 for 0.05 ETH → AAPL on Robinhood, trimmed to what the site reads. */
const fixture = (over: Partial<LifiQuoteJson> = {}): LifiQuoteJson => ({
  tool: "fly",
  toolDetails: { name: "Fly" },
  action: { fromChainId: 4663, toChainId: 4663, fromToken: { address: zeroAddress, decimals: 18 }, toToken: { address: AAPL, decimals: 18 }, fromAmount: "50000000000000000", fromAddress: WALLET, toAddress: WALLET },
  estimate: { toAmount: "365440460923972016", toAmountMin: "363613258619353155", approvalAddress: LIFI_DIAMOND.robinhood, executionDuration: 30, fromAmountUSD: "119.85", toAmountUSD: "116.64", feeCosts: [{ amountUSD: "0.30", included: false }], gasCosts: [{ amountUSD: "0.02" }] },
  transactionRequest: { to: LIFI_DIAMOND.robinhood, data: "0x1234", value: "0xb1a2bc2ec50000", chainId: 4663, gasLimit: "0x7a120" },
  ...over,
});

const input: LifiQuoteInput = { chain: "robinhood", fromToken: zeroAddress, toToken: AAPL, fromAmount: 50000000000000000n, wallet: WALLET, slippageBps: 300 };

describe("a LI.FI quote is checked before the browser signs it", () => {
  it("accepts a quote that matches the request", () => {
    expect(checkLifiQuote(fixture(), input)).toEqual([]);
    const q = parseLifiQuote(fixture(), input);
    expect(q.toAmount).toBe(365440460923972016n);
    expect(q.toAmountMin).toBe(363613258619353155n);
    expect(q.tx?.to).toBe(LIFI_DIAMOND.robinhood);
    expect(q.tx?.value).toBe(50000000000000000n);
    expect(q.approvalAddress).toBeNull();
    expect(q.feeUsd).toBeCloseTo(0.3);
    expect(q.gasUsd).toBeCloseTo(0.02);
    expect(q.toolName).toBe("Fly");
  });

  it("refuses a transaction that targets anything but LI.FI's contract on that chain", () => {
    const problems = checkLifiQuote(fixture({ transactionRequest: { ...fixture().transactionRequest, to: "0x9999999999999999999999999999999999999999" } }), input);
    expect(problems.join()).toMatch(/not LI\.FI's contract/);
    expect(() => parseLifiQuote(fixture({ transactionRequest: { ...fixture().transactionRequest, to: "0x9999999999999999999999999999999999999999" } }), input)).toThrow(/does not match/);
  });

  it("refuses a route that leaves the chain, another recipient, or a changed amount", () => {
    expect(checkLifiQuote(fixture({ action: { ...fixture().action, toChainId: 8453 } }), input).join()).toMatch(/not a swap on chain 4663/);
    expect(checkLifiQuote(fixture({ action: { ...fixture().action, toAddress: "0x2222222222222222222222222222222222222222" } }), input).join()).toMatch(/recipient/);
    expect(checkLifiQuote(fixture({ transactionRequest: { ...fixture().transactionRequest, value: "0x1" } }), input).join()).toMatch(/value/);
    expect(checkLifiQuote(fixture({ action: { ...fixture().action, fromAmount: "1" } }), input).join()).toMatch(/input amount/);
  });

  it("expects no native value and an approval to LI.FI for an ERC-20 input", () => {
    const erc20In: LifiQuoteInput = { ...input, fromToken: AAPL, toToken: zeroAddress, fromAmount: 10n ** 18n };
    const q = fixture({
      action: { ...fixture().action, fromToken: { address: AAPL, decimals: 18 }, toToken: { address: zeroAddress, decimals: 18 }, fromAmount: (10n ** 18n).toString() },
      transactionRequest: { ...fixture().transactionRequest, value: "0x0" },
    });
    expect(checkLifiQuote(q, erc20In)).toEqual([]);
    expect(parseLifiQuote(q, erc20In).approvalAddress).toBe(LIFI_DIAMOND.robinhood);
    expect(checkLifiQuote(fixture({ ...q, transactionRequest: { ...q.transactionRequest, value: "0x5" } }), erc20In).join()).toMatch(/native value/);
    expect(checkLifiQuote({ ...q, estimate: { ...q.estimate, approvalAddress: "0x9999999999999999999999999999999999999999" } }, erc20In).join()).toMatch(/approval address/);
  });

  it("allows a look-only quote for nobody without a transaction", () => {
    const look: LifiQuoteInput = { ...input, wallet: NOBODY };
    const q = fixture({ action: { ...fixture().action, fromAddress: NOBODY, toAddress: NOBODY }, transactionRequest: undefined });
    expect(checkLifiQuote(q, look)).toEqual([]);
    expect(parseLifiQuote(q, look).tx).toBeNull();
  });

  it("explains LI.FI's error codes in plain words", () => {
    expect(describeLifiError(200, { code: 1002, message: "No available quotes for the requested transfer" })).toMatch(/No route/);
    expect(describeLifiError(429, {})).toMatch(/Too many/);
    expect(describeLifiError(400, { message: "something odd" })).toBe("something odd");
  });
});
