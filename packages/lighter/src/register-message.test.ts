import { describe, expect, it } from "vitest";
import {
  REGISTER_MESSAGE_BYTES,
  REGISTER_MESSAGE_PREFIX,
  buildRegisterMessage,
  hex16,
  parseRegisterMessage,
  registerMessageSuffix,
} from "./register-message";

const PUB = `0x${"ab".repeat(40)}`;
const SAMPLE = { pubKey: PUB, nonce: 0n, accountIndex: 50n, apiKeyIndex: 5 };

describe("register message", () => {
  it("prints fields the way lighter-go does: 0x and sixteen hex digits", () => {
    // BUILD.txt, verified 2026-09-21: "account index: 0x0000000000000032" for account 50.
    expect(hex16(50)).toBe("0x0000000000000032");
    expect(hex16(4)).toBe("0x0000000000000004");
    expect(() => hex16(-1)).toThrow(RangeError);
  });

  it("builds a message of exactly the pinned length, whatever the field values", () => {
    for (const m of [SAMPLE, { ...SAMPLE, nonce: 12345678n, accountIndex: 281474976710398n, apiKeyIndex: 255 }]) {
      const msg = buildRegisterMessage(m);
      expect(new TextEncoder().encode(msg).length).toBe(REGISTER_MESSAGE_BYTES);
      expect(msg.startsWith(REGISTER_MESSAGE_PREFIX)).toBe(true);
      expect(msg.endsWith(registerMessageSuffix(m.apiKeyIndex))).toBe(true);
    }
  });

  it("matches the venue's template line for line", () => {
    expect(buildRegisterMessage(SAMPLE)).toBe(
      "Register Lighter Account\n\n" +
        `pubkey: ${PUB}\n` +
        "nonce: 0x0000000000000000\n" +
        "account index: 0x0000000000000032\n" +
        "api key index: 0x0000000000000005\n" +
        "Only sign this message for a trusted client!",
    );
  });

  it("parses back exactly what was built", () => {
    expect(parseRegisterMessage(buildRegisterMessage(SAMPLE))).toEqual(SAMPLE);
  });

  it("returns null for anything that is not precisely a registration message", () => {
    const msg = buildRegisterMessage(SAMPLE);
    for (const bad of [
      msg + "\n",
      " " + msg,
      msg.replace("Register Lighter Account", "Transfer"),
      msg.replace("api key index: 0x0000000000000005", "api key index: 0x05"),
      msg.replace(PUB, PUB.toUpperCase()),
      "Approve Integrator\n\nnonce: 0x0000000000000000\nOnly sign this message for a trusted client!",
      "",
    ]) {
      expect(parseRegisterMessage(bad), JSON.stringify(bad.slice(0, 40))).toBeNull();
    }
  });

  it("pins the suffix to one api key slot", () => {
    expect(registerMessageSuffix(5)).toBe("\napi key index: 0x0000000000000005\nOnly sign this message for a trusted client!");
    expect(buildRegisterMessage({ ...SAMPLE, apiKeyIndex: 4 }).endsWith(registerMessageSuffix(5))).toBe(false);
  });
});
