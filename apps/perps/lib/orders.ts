import {
  API_KEY_INDEX,
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  VAULT_MESSAGE,
  isSignerError,
  loadSigner,
  openApiKey,
  type ActiveOrder,
  type LighterClient,
} from "@o1bot/lighter";
import { SIGNER_EXEC_URL, SIGNER_WASM_URL, vaultKey } from "@/lib/register";
import { NoKeyError } from "@/lib/submit";

type SignMessage = (message: string) => Promise<string>;

/**
 * Reading open orders needs a token the venue issues to a signed request, and
 * producing one means unsealing the key, which costs a wallet signature. Doing
 * that on every poll would put a signature prompt in front of anyone who left
 * the tab open, so tokens are kept for their lifetime.
 *
 * In memory only: a page reload costs one signature, which is a fair price for
 * not leaving a bearer credential in storage.
 */
const tokens = new Map<number, { token: string; expiresAt: number }>();

/** The venue defaults to seven hours; ask for less and refresh well before it. */
const TOKEN_TTL_SECONDS = 6 * 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function authTokenFor(
  accountIndex: number,
  signMessage: SignMessage,
  store?: Pick<Storage, "getItem">,
): Promise<string> {
  const cached = tokens.get(accountIndex);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

  const s = store ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) throw new Error("no storage available");
  const sealed = s.getItem(vaultKey(accountIndex));
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

  const deadline = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const res = signer.CreateAuthToken(deadline, API_KEY_INDEX, accountIndex);
  if (isSignerError(res)) throw new Error(`could not create an auth token: ${res.error}`);

  tokens.set(accountIndex, { token: res.authToken, expiresAt: deadline * 1000 });
  return res.authToken;
}

/** Drop a cached token, so the next read mints a fresh one. */
export function forgetToken(accountIndex: number): void {
  tokens.delete(accountIndex);
}

export interface OpenOrder {
  orderIndex: number;
  marketId: number | null;
  price: string | null;
  remaining: string | null;
  initial: string | null;
  isAsk: boolean | null;
  expiryMs: number | null;
}

function normalise(o: ActiveOrder): OpenOrder {
  const ask = o.is_ask;
  return {
    orderIndex: o.order_index,
    marketId: typeof o.market_id === "number" ? o.market_id : null,
    price: o.price ?? null,
    remaining: o.remaining_base_amount ?? null,
    initial: o.initial_base_amount ?? null,
    isAsk: typeof ask === "boolean" ? ask : typeof ask === "number" ? ask === 1 : null,
    expiryMs: typeof o.order_expiry === "number" ? o.order_expiry : null,
  };
}

export class UnexpectedShapeError extends Error {
  constructor(readonly keys: string[]) {
    super(`the venue returned no orders array (top-level keys: ${keys.join(", ") || "none"})`);
    this.name = "UnexpectedShapeError";
  }
}

/**
 * Open orders for the account.
 *
 * The field names come from the public orderBookOrders endpoint, which returns
 * the same resting-order objects. This account-wide endpoint has never been
 * called with a valid token — it needs a funded account with a registered key —
 * so if the payload carries orders under another name, the error names the keys
 * that did come back rather than rendering an empty table that reads as "you
 * have no orders".
 */
export async function openOrders(
  client: LighterClient,
  accountIndex: number,
  authToken: string,
): Promise<OpenOrder[]> {
  const res = await client.accountActiveOrders(accountIndex, authToken);
  const raw = (res as { orders?: ActiveOrder[] }).orders;
  if (!Array.isArray(raw)) {
    throw new UnexpectedShapeError(Object.keys(res).filter((k) => k !== "code"));
  }
  return raw.map(normalise);
}
