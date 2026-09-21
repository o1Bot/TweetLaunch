import {
  API_KEY_INDEX,
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  VAULT_MESSAGE,
  isSignerError,
  loadSigner,
  openApiKey,
  type BuiltOrder,
  type LighterClient,
} from "@o1bot/lighter";
import { NO_INTEGRATOR, SELF_TRADE } from "@/lib/ticket";
import { SIGNER_EXEC_URL, SIGNER_WASM_URL, vaultKey } from "@/lib/register";

export interface SubmitInput {
  client: LighterClient;
  accountIndex: number;
  built: BuiltOrder;
  /** personal_sign from the wallet that owns the account. */
  signMessage: (message: string) => Promise<string>;
  store?: Pick<Storage, "getItem">;
}

export class NoKeyError extends Error {
  constructor() {
    super("no signing key on this device for that account");
    this.name = "NoKeyError";
  }
}

/**
 * Send one order.
 *
 * The signing key is unsealed for the duration of this call and never leaves
 * it. Unsealing needs the wallet signature over VAULT_MESSAGE, which is why
 * placing an order asks for a signature: the key is encrypted at rest and the
 * wallet is what decrypts it.
 *
 * `built` comes from quote() and is passed through untouched. Nothing here
 * recomputes a size or a price, because the figures the user approved are the
 * ones that must go on the wire.
 */
export async function submitOrder(input: SubmitInput): Promise<{ txHash: string }> {
  const { client, accountIndex, built, signMessage } = input;

  const store = input.store ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!store) throw new Error("no storage available");
  const sealed = store.getItem(vaultKey(accountIndex));
  if (!sealed) throw new NoKeyError();

  const vaultSignature = await signMessage(VAULT_MESSAGE);
  const privateKey = await openApiKey(sealed, vaultSignature);

  const signer = await loadSigner({ wasmUrl: SIGNER_WASM_URL, wasmExecUrl: SIGNER_EXEC_URL });
  const created = signer.CreateClient(
    DEFAULT_BASE_URL,
    privateKey,
    L2_CHAIN_ID,
    API_KEY_INDEX,
    accountIndex,
  );
  if (isSignerError(created)) throw new Error(`could not create a signing client: ${created.error}`);

  const { nonce } = await client.nextNonce(accountIndex, API_KEY_INDEX);

  // The venue dedupes on this, so two orders from one account must not share it.
  const clientOrderIndex = Date.now();

  const tx = signer.SignCreateOrder(
    built.marketIndex,
    clientOrderIndex,
    built.baseAmount,
    built.price,
    built.isAsk,
    built.orderType,
    built.timeInForce,
    built.reduceOnly,
    built.triggerPrice,
    built.orderExpiry,
    NO_INTEGRATOR.accountIndex,
    NO_INTEGRATOR.takerFeePpm,
    NO_INTEGRATOR.makerFeePpm,
    SELF_TRADE.behaviour,
    SELF_TRADE.equality,
    0, // skipNonce: use the nonce above
    nonce,
    API_KEY_INDEX,
    accountIndex,
  );
  if (isSignerError(tx)) throw new Error(`could not sign the order: ${tx.error}`);

  // Unlike a registration, an order carries no L1 message: the L2 key that was
  // registered is the authority, which is the point of registering one.
  await client.sendTx(tx.txType, tx.txInfo);

  return { txHash: tx.txHash };
}
