import type { User } from "@privy-io/server-auth";
import { getAddress } from "viem";
import { logger, normalizeHandle } from "@o1bot/shared";
import { privy, privyPolicyId, privySignerId } from "./privy";
import { PREGEN_METADATA_KEY, PREGEN_METADATA_VALUE, type EmbeddedWallet, type LinkStatus, type LinkedUser } from "./types";

/**
 * X account ↔ Privy user ↔ embedded wallet.
 *
 * Lookups are keyed by the stable X user ID (OAuth subject), never by handle,
 * because handles change. `findUserByHandle` exists only to turn a
 * `fees to @handle` mention into an ID via the X API first.
 */

type LinkedAccount = User["linkedAccounts"][number];

function pickEmbeddedWallet(user: User): EmbeddedWallet | null {
  const wallets = user.linkedAccounts.filter(
    (a): a is Extract<LinkedAccount, { type: "wallet" }> =>
      a.type === "wallet" && a.chainType === "ethereum" && a.walletClientType === "privy",
  );
  const w = wallets[0];
  if (!w?.address) return null;
  return { address: getAddress(w.address), walletId: w.id ?? null, delegated: Boolean(w.delegated) };
}

export function toLinkedUser(user: User): LinkedUser | null {
  const tw = user.twitter;
  if (!tw?.subject) return null;
  const pregenerated = user.customMetadata?.[PREGEN_METADATA_KEY] === PREGEN_METADATA_VALUE;
  // Imported (pregenerated) accounts have never been used to log in.
  const hasLoggedIn = Boolean(tw.latestVerifiedAt);
  return {
    privyUserId: user.id,
    xUserId: tw.subject,
    xHandle: tw.username ? normalizeHandle(tw.username) : null,
    xName: tw.name ?? null,
    xAvatarUrl: tw.profilePictureUrl ?? null,
    wallet: pickEmbeddedWallet(user),
    hasLoggedIn,
    pregenerated: pregenerated && !hasLoggedIn,
  };
}

export type SignerState = { granted: boolean; stale: boolean };
type WalletSigners = { ownerId?: string | null; additionalSigners?: Array<{ signerId: string; overridePolicyIds?: string[] | null }> | null };

/**
 * Whether o1bot's signer on a wallet counts. With a policy configured, a
 * signer added before the policy existed is "stale": it must not be used
 * (the enclave would sign without the policy's limits) and the user is
 * asked to grant again.
 */
export function signerState(wallet: WalletSigners, signerId: string, policyId: string | null): SignerState {
  if (wallet.ownerId === signerId) return { granted: true, stale: false };
  const signer = (wallet.additionalSigners ?? []).find((s) => s.signerId === signerId);
  if (!signer) return { granted: false, stale: false };
  if (!policyId) return { granted: true, stale: false };
  const hasPolicy = (signer.overridePolicyIds ?? []).includes(policyId);
  return { granted: hasPolicy, stale: !hasPolicy };
}

/**
 * "Delegated" for TEE wallets means o1bot's key quorum is a signer on the
 * wallet, carrying the policy when one is configured. The user object does
 * not say so; the wallet API does. The legacy on-device `delegated` flag
 * is kept as a fallback for apps still on it, never for a stale signer.
 */
export async function withSignerStatus(user: LinkedUser | null): Promise<LinkedUser | null> {
  const signerId = privySignerId();
  if (!user?.wallet?.walletId || !signerId) return user;
  try {
    const w = await privy().walletApi.getWallet({ id: user.wallet.walletId });
    const state = signerState(w as WalletSigners, signerId, privyPolicyId());
    return { ...user, wallet: { ...user.wallet, delegated: state.granted || (!state.stale && user.wallet.delegated), signerStale: state.stale } };
  } catch (err) {
    logger.warn({ walletId: user.wallet.walletId, err: err instanceof Error ? err.message : String(err) }, "could not read wallet signers");
    return user;
  }
}

export async function findUserByXUserId(xUserId: string): Promise<LinkedUser | null> {
  const user = await privy().getUserByTwitterSubject(xUserId);
  return withSignerStatus(user ? toLinkedUser(user) : null);
}

export async function findUserByPrivyId(privyUserId: string): Promise<LinkedUser | null> {
  const user = await privy().getUserById(privyUserId);
  return withSignerStatus(user ? toLinkedUser(user) : null);
}

/** Handle lookups are a convenience only; resolve handle → ID via X first when it matters. */
export async function findUserByHandle(handle: string): Promise<LinkedUser | null> {
  const clean = normalizeHandle(handle);
  if (!clean) return null;
  const user = await privy().getUserByTwitterUsername(clean);
  return withSignerStatus(user ? toLinkedUser(user) : null);
}

/**
 * Registration rule for the bot: the X account has logged in on o1bot at least
 * once, has a Privy embedded wallet with a server-wallet ID, and delegated
 * signing to o1bot. A wallet that only exists because of `fees to` is NOT linked.
 */
export function linkStatus(user: LinkedUser | null): LinkStatus {
  if (!user) return { linked: false, reason: "no_account", user: null };
  if (!user.hasLoggedIn) return { linked: false, reason: "never_logged_in", user };
  if (!user.wallet?.walletId) return { linked: false, reason: "no_embedded_wallet", user };
  if (!user.wallet.delegated) return { linked: false, reason: "not_delegated", user };
  return { linked: true, user, wallet: user.wallet };
}

export type EnsureWalletInput = {
  xUserId: string;
  username: string;
  name?: string | null;
  avatarUrl?: string | null;
};

/**
 * Return the embedded wallet for an X user, creating a pregenerated Privy
 * user + wallet keyed by X user ID when none exists. Used for `fees to @b`
 * recipients. When @b later logs in with X, Privy hands them this wallet.
 */
export async function ensureWalletForXUser(input: EnsureWalletInput): Promise<LinkedUser> {
  const client = privy();
  const existing = await client.getUserByTwitterSubject(input.xUserId);
  if (existing) {
    const linked = toLinkedUser(existing);
    if (linked?.wallet) return linked;
    const withWallet = await client.createWallets({ userId: existing.id, createEthereumWallet: true });
    const result = toLinkedUser(withWallet);
    if (!result?.wallet) throw new Error("Privy createWallets returned no ethereum wallet");
    return result;
  }

  const username = normalizeHandle(input.username);
  if (!username) throw new Error(`invalid X username for pregeneration: ${input.username}`);
  const twitter: Record<string, string> = { type: "twitter_oauth", subject: input.xUserId, username };
  if (input.name) twitter.name = input.name;
  if (input.avatarUrl) twitter.profilePictureUrl = input.avatarUrl;

  try {
    const created = await client.importUser({
      // Privy's typed union is narrower than what it accepts; cast at the boundary.
      linkedAccounts: [twitter as unknown as Parameters<typeof client.importUser>[0]["linkedAccounts"][number]],
      createEthereumWallet: true,
      customMetadata: { [PREGEN_METADATA_KEY]: PREGEN_METADATA_VALUE },
    });
    const result = toLinkedUser(created);
    if (!result?.wallet) throw new Error("Privy importUser returned no ethereum wallet");
    logger.info({ xUserId: input.xUserId, address: result.wallet.address }, "pregenerated wallet");
    return result;
  } catch (err) {
    // Lost a race with a concurrent pregeneration: re-read once.
    const again = await client.getUserByTwitterSubject(input.xUserId);
    const linked = again ? toLinkedUser(again) : null;
    if (linked?.wallet) return linked;
    throw err;
  }
}
