import { BOT_API_KEY_INDEX, REGISTER_MESSAGE_BYTES, REGISTER_MESSAGE_PREFIX, registerMessageSuffix } from "@o1bot/lighter";

/**
 * Policy rules shared by the script that creates the signer policy and the
 * one that adds a rule to it in place, so the two can never drift.
 */

/**
 * Perps from a post: the one message the signer may sign is Lighter's key
 * registration, pinned by its prefix, by the bot's slot in its suffix and by
 * its fixed length. It registers a key on an account the wallet owns; it
 * cannot move funds. The bot also checks the account and key named inside
 * the message before asking (packages/wallet, message policy).
 */
export function lighterRegistrationRule() {
  return {
    name: "Lighter key registration (perps from a post)",
    method: "personal_sign",
    action: "ALLOW",
    conditions: [
      { field_source: "message", field: "content", operator: "starts_with", value: REGISTER_MESSAGE_PREFIX },
      { field_source: "message", field: "content", operator: "ends_with", value: registerMessageSuffix(BOT_API_KEY_INDEX) },
      { field_source: "message", field: "byte_length", operator: "eq", value: String(REGISTER_MESSAGE_BYTES) },
    ],
  } as const;
}
