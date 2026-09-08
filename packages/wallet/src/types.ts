import type { Address } from "viem";

export type EmbeddedWallet = {
  address: Address;
  /** Privy server-wallet ID. Null means the server cannot sign for it. */
  walletId: string | null;
  /** User granted delegated signing to o1bot. */
  delegated: boolean;
  /** The signer is on the wallet without the policy this deployment requires; the user must grant again. */
  signerStale?: boolean;
};

export type LinkedUser = {
  privyUserId: string;
  /** Stable X user ID (OAuth subject). */
  xUserId: string;
  xHandle: string | null;
  xName: string | null;
  xAvatarUrl: string | null;
  wallet: EmbeddedWallet | null;
  /** The X account has completed at least one real login on o1bot. */
  hasLoggedIn: boolean;
  /** Wallet was created by the bot for a `fees to` target, not by a login. */
  pregenerated: boolean;
};

export type LinkStatus =
  | { linked: true; user: LinkedUser; wallet: EmbeddedWallet }
  | { linked: false; reason: "no_account" | "never_logged_in" | "no_embedded_wallet" | "not_delegated"; user: LinkedUser | null };

export const PREGEN_METADATA_KEY = "pregeneratedBy";
export const PREGEN_METADATA_VALUE = "o1bot";
