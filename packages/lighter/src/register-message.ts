/**
 * The message Lighter asks the account's L1 wallet to sign when a key is
 * registered — `TemplateChangePubKey` in types/txtypes/utils.go, lighter-go
 * commit c26ac340:
 *
 *   Register Lighter Account
 *
 *   pubkey: 0x<40 bytes>
 *   nonce: 0x<16 hex>
 *   account index: 0x<16 hex>
 *   api key index: 0x<16 hex>
 *   Only sign this message for a trusted client!
 *
 * Every field is hex-padded (getHex10FromUint64 pads to 16 and re-adds the
 * 0x), so the whole message is always the same length. That fixedness is what
 * lets a signing policy pin it — prefix, suffix and byte count — without
 * parsing, and what lets this module parse it without guessing.
 *
 * Signing this message registers a key on an account; it cannot move money.
 * What the key can then do is the whole question, which is why the bot only
 * ever asks for it on accounts whose owner opted in.
 */

/** txtypes.TxTypeL2ChangePubKey; the venue's answer to a registration carries it. */
export const TX_TYPE_L2_CHANGE_PUB_KEY = 8;

export const REGISTER_MESSAGE_PREFIX = "Register Lighter Account\n\npubkey: 0x";
export const REGISTER_MESSAGE_FOOTER = "\nOnly sign this message for a trusted client!";
/** 36 + 80 + 10 + 16 + 18 + 16 + 18 + 16 + 45. Checked by test against a built message. */
export const REGISTER_MESSAGE_BYTES = 255;

/** A uint64 the way the template prints it: 0x and sixteen lowercase hex digits. */
export function hex16(n: number | bigint): string {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError("not a uint64");
  return `0x${v.toString(16).padStart(16, "0")}`;
}

/** The tail a policy can pin: our slot, then the footer. Fixed for a given api key index. */
export function registerMessageSuffix(apiKeyIndex: number): string {
  return `\napi key index: ${hex16(apiKeyIndex)}${REGISTER_MESSAGE_FOOTER}`;
}

export interface RegisterMessage {
  /** 0x + 40 bytes, lowercase. */
  pubKey: string;
  nonce: bigint;
  accountIndex: bigint;
  apiKeyIndex: number;
}

export function buildRegisterMessage(m: RegisterMessage): string {
  const pub = m.pubKey.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(pub)) throw new RangeError("pubKey must be 40 bytes of hex");
  return `${REGISTER_MESSAGE_PREFIX}${pub}\nnonce: ${hex16(m.nonce)}\naccount index: ${hex16(m.accountIndex)}\napi key index: ${hex16(m.apiKeyIndex)}${REGISTER_MESSAGE_FOOTER}`;
}

const SHAPE =
  /^Register Lighter Account\n\npubkey: 0x([0-9a-f]{80})\nnonce: 0x([0-9a-f]{16})\naccount index: 0x([0-9a-f]{16})\napi key index: 0x([0-9a-f]{16})\nOnly sign this message for a trusted client!$/;

/** The fields of a registration message, or null for anything that is not exactly one. */
export function parseRegisterMessage(message: string): RegisterMessage | null {
  const m = SHAPE.exec(message);
  if (!m) return null;
  return {
    pubKey: `0x${m[1]}`,
    nonce: BigInt(`0x${m[2]}`),
    accountIndex: BigInt(`0x${m[3]}`),
    apiKeyIndex: Number(BigInt(`0x${m[4]}`)),
  };
}
