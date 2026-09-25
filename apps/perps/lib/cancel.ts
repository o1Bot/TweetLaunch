import {
  API_KEY_INDEX,
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  VAULT_MESSAGE,
  isSignerError,
  loadSigner,
  openApiKey,
  type LighterClient,
} from "@o1bot/lighter";
import { SIGNER_EXEC_URL, SIGNER_WASM_URL, vaultKey } from "@/lib/register";
import { NoKeyError } from "@/lib/submit";

export interface CancelInput {
  client: LighterClient;
  accountIndex: number;
  marketId: number;
  /** The venue's own order index, not the client order index. */
  orderIndex: number;
  signMessage: (message: string) => Promise<string>;
  store?: Pick<Storage, "getItem">;
}

/**
 * Cancel one resting order.
 *
 * `orderIndex` must be the venue's order_index — the field the public
 * orderBookOrders endpoint returns alongside a matching order_id string. The
 * signer's own comment says so: passing the client order index instead would
 * sign a cancel for an order that does not exist, which the venue rejects
 * rather than cancelling the wrong one, but it would still look like a failure
 * with no cause.
 */
export async function cancelOrder(input: CancelInput): Promise<{ txHash: string }> {
  const { client, accountIndex, marketId, orderIndex, signMessage } = input;

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

  const tx = signer.SignCancelOrder(marketId, orderIndex, 0, nonce, API_KEY_INDEX, accountIndex);
  if (isSignerError(tx)) throw new Error(`could not sign the cancel: ${tx.error}`);

  await client.sendTx(tx.txType, tx.txInfo);
  return { txHash: tx.txHash };
}
