import { describe, expect, it } from "vitest";
import { replies, stripBareAddresses, tokenRef } from "../src/replies";

/**
 * X refuses posts with a bare crypto address from accounts whose app was
 * authenticated less than seven days ago. Every reply that can carry one
 * needs an address-free variant, and the pipeline makes one when a reply
 * has none.
 */

const ADDR = "0xF7d77243Fbd0413a6528edc275b09D31c25CB201";

describe("stripBareAddresses", () => {
  it("replaces bare addresses and leaves addresses inside URLs alone", () => {
    expect(stripBareAddresses(`Contract: ${ADDR}. Chart: https://o1bot.exchange/token/${ADDR}`)).toBe(`Contract: the address on the token page. Chart: https://o1bot.exchange/token/${ADDR}`);
    expect(stripBareAddresses(`${ADDR} is live`)).toBe("the address on the token page is live");
    expect(stripBareAddresses(`(${ADDR})`)).toBe("(the address on the token page)");
    expect(stripBareAddresses(`https://rh-scan.com/address/${ADDR}?tab=1`)).toContain(ADDR);
  });

  it("leaves text without addresses untouched", () => {
    const text = "0x1234 is not an address and neither is https://x.com";
    expect(stripBareAddresses(text)).toBe(text);
  });
});

describe("replies that name a token the user gave by address", () => {
  it("never echo the address", () => {
    expect(tokenRef(ADDR)).toBe("the token at that address");
    expect(tokenRef("CAT")).toBe("$CAT");
    for (const text of [replies.siteUnknownToken(ADDR, "https://o1bot.exchange"), replies.askTokenUnknown(ADDR, "https://o1bot.exchange"), replies.tradeUnknownToken("0xF7d7…", "https://o1bot.exchange")]) {
      expect(text).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    }
    expect(replies.siteNotCreator("CAT")).toBe("Only the creator of $CAT can ask for its site.");
  });

  it("gives the ambiguous-ticker replies an address-free variant", () => {
    const trade = replies.tradeAmbiguous("CAT", [{ name: "Cash Cat", token: ADDR, liquidityUsd: 1234 }, { name: "Other Cat", token: ADDR.replace("F7", "00"), liquidityUsd: null }]);
    expect(trade.text).toContain(ADDR);
    expect(trade.safe).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    expect(trade.safe).toContain("Cash Cat ($1,234 liquidity), Other Cat");
    const site = replies.siteAmbiguous("CAT", [{ name: "Cash Cat", token: ADDR }]);
    expect(site.safe).not.toMatch(/0x[0-9a-fA-F]{6,}/);
  });
});
