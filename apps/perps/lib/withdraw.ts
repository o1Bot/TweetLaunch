import {
  API_KEY_INDEX,
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  TX_TYPE_L2_WITHDRAW,
  VAULT_MESSAGE,
  isSignerError,
  loadSigner,
  openApiKey,
  type BuiltWithdraw,
  type LighterClient,
} from "@o1bot/lighter";
import { SIGNER_EXEC_URL, SIGNER_WASM_URL, vaultKey } from "@/lib/register";
import { NoKeyError } from "@/lib/submit";

export interface WithdrawSubmitInput {
  client: LighterClient;
  accountIndex: number;
  built: BuiltWithdraw;
  /** personal_sign from the wallet that owns the account. */
  signMessage: (message: string) => Promise<string>;
  store?: Pick<Storage, "getItem">;
}

/**
 * Send one withdrawal by the secure route.
 *
 * Same shape as submitOrder: the signing key is unsealed for this call and
 * never leaves it, which is why withdrawing asks the wallet for one signature
 * — over the vault message, not over the withdrawal. The venue pays out to the
 * address that owns the account; nothing signed here chooses a destination.
 *
 * `built` comes from buildWithdraw() and goes on the wire untouched: the amount
 * the user approved is the amount that leaves.
 */
export async function submitWithdraw(input: WithdrawSubmitInput): Promise<{ txHash: string }> {
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

  const tx = signer.SignWithdraw(
    built.assetIndex,
    built.routeType,
    built.amount,
    0,
    nonce,
    API_KEY_INDEX,
    accountIndex,
  );
  if (isSignerError(tx)) throw new Error(`could not sign the withdrawal: ${tx.error}`);

  // The binding's argument order is declared by hand from the pinned source.
  // If the module signed anything other than a withdraw, the arguments are not
  // what this code believes they are, and nothing should go on the wire.
  if (tx.txType !== TX_TYPE_L2_WITHDRAW) {
    throw new Error(`signer produced tx type ${tx.txType}, expected a withdraw (${TX_TYPE_L2_WITHDRAW})`);
  }

  await client.sendTx(tx.txType, tx.txInfo);
  return { txHash: tx.txHash };
}
