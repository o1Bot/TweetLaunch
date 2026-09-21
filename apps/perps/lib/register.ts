import {
  API_KEY_INDEX,
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  isSignerError,
  loadSigner,
  sealApiKey,
  VAULT_MESSAGE,
  type LighterClient,
} from "@o1bot/lighter";

export const SIGNER_WASM_URL = "/signer/lighter-signer.wasm";
export const SIGNER_EXEC_URL = "/signer/wasm_exec.js";

/** Where a sealed key lives. Keyed by account so two linked wallets do not collide. */
export function vaultKey(accountIndex: number): string {
  return `o1bot.perps.key.${accountIndex}`;
}

export type SignMessage = (message: string) => Promise<string>;

export interface RegisterInput {
  client: LighterClient;
  accountIndex: number;
  /** personal_sign from the connected wallet. */
  signMessage: SignMessage;
  /** Defaults to localStorage; injectable so the flow is testable. */
  store?: Pick<Storage, "getItem" | "setItem">;
}

export interface RegisterResult {
  publicKey: string;
  nonce: number;
  txHash: string;
}

function storage(s?: RegisterInput["store"]): Pick<Storage, "getItem" | "setItem"> {
  if (s) return s;
  if (typeof localStorage === "undefined") throw new Error("no storage available");
  return localStorage;
}

/**
 * Register a signing key for one Lighter account.
 *
 * Order matters more than it looks. The private key is sealed and stored BEFORE
 * the registration is broadcast, because the reverse order has a failure that
 * cannot be undone: if the broadcast lands and the user then rejects the vault
 * signature, the venue holds a public key whose private half no longer exists
 * anywhere. The slot is occupied by a key nobody can sign with, and the only
 * way out is to register again over the top. Sealing first can only fail the
 * harmless way — a stored key that was never registered, which the next attempt
 * replaces.
 *
 * Two wallet signatures are unavoidable and mean different things:
 *   1. VAULT_MESSAGE  — derives the local encryption key. Authorises nothing.
 *   2. messageToSign  — "Register Lighter Account …", which the venue recovers
 *                       an address from to prove the account owner asked for it.
 *
 * The private key is never returned, logged, or sent anywhere. It exists in
 * this function's scope and inside the sealed blob, and nowhere else.
 */
export async function registerApiKey(input: RegisterInput): Promise<RegisterResult> {
  const { client, accountIndex, signMessage } = input;
  const store = storage(input.store);

  const signer = await loadSigner({ wasmUrl: SIGNER_WASM_URL, wasmExecUrl: SIGNER_EXEC_URL });

  const generated = signer.GenerateAPIKey();
  if (isSignerError(generated)) throw new Error(`could not generate a key: ${generated.error}`);
  const { privateKey, publicKey } = generated;

  // Seal first — see above.
  const vaultSignature = await signMessage(VAULT_MESSAGE);
  const sealed = await sealApiKey(privateKey, vaultSignature);
  store.setItem(vaultKey(accountIndex), sealed);

  // The signer keeps clients in a registry keyed by (apiKeyIndex, accountIndex);
  // SignChangePubKey looks this up rather than taking the key again.
  const created = signer.CreateClient(
    DEFAULT_BASE_URL,
    privateKey,
    L2_CHAIN_ID,
    API_KEY_INDEX,
    accountIndex,
  );
  if (isSignerError(created)) throw new Error(`could not create a signing client: ${created.error}`);

  // 0 for an unused slot, the current value for a re-registration; the venue
  // answers for both, so this is not branched on.
  const { nonce } = await client.nextNonce(accountIndex, API_KEY_INDEX);

  // skipNonce = 0: use the nonce above. Passing 1 sets the skip-nonce attribute,
  // which is not what a registration wants.
  const tx = signer.SignChangePubKey(publicKey, 0, nonce, API_KEY_INDEX, accountIndex);
  if (isSignerError(tx)) throw new Error(`could not sign the registration: ${tx.error}`);
  if (!tx.messageToSign) throw new Error("signer returned no message for the wallet to sign");

  const l1Sig = await signMessage(tx.messageToSign);

  // The venue recovers the signer's address from L1Sig over messageToSign and
  // checks it against the account's L1 address, so the field has to go back
  // into the same payload rather than alongside it.
  const payload = JSON.parse(tx.txInfo) as Record<string, unknown>;
  payload.L1Sig = l1Sig;

  await client.sendTx(tx.txType, JSON.stringify(payload));

  return { publicKey, nonce, txHash: tx.txHash };
}
