import { createViemAccount } from "@privy-io/server-auth/viem";
import { keccak256, toBytes, type Address, type Hex, type LocalAccount } from "viem";
import { checkTransaction, logger, type AllowedTxKind, type TxAllowlist } from "@o1bot/shared";
import { privy } from "./privy";

/**
 * A viem account backed by the user's Privy embedded wallet, wrapped so it
 * can only sign transactions that pass the o1 allow-list. The wrapper
 * exposes exactly the `LocalAccount` surface and nothing from the inner
 * account leaks through: raw hash, message, typed-data and EIP-7702
 * signing all refuse, whatever Privy's account happens to implement. The
 * bot has no reason to sign anything but a launch, an approval, a
 * fee-recipient update, or a claim.
 */

export class TxNotAllowedError extends Error {
  constructor(reason: string) {
    super(`refused to sign: ${reason}`);
    this.name = "TxNotAllowedError";
  }
}

export type SignAudit = {
  kind: AllowedTxKind;
  chainId: number;
  wallet: Address;
  to: Address;
  calldataHash: Hex;
  valueWei: string;
};

export type MessageAudit = {
  kind: string;
  wallet: Address;
  messageHash: Hex;
  bytes: number;
};

/**
 * Message signing, off unless given. The only message a bot wallet has any
 * business signing is Lighter's "Register Lighter Account", and `allow` is
 * where that is checked field by field: Privy's policy pins the shape of the
 * message in the enclave, this pins its meaning (which account, which slot).
 */
export type MessagePolicy = {
  allow: (message: string) => { ok: true; kind: string } | { ok: false; reason: string };
  audit: (record: MessageAudit) => Promise<void> | void;
};

export type GuardedAccountInput = {
  walletId: string;
  address: Address;
  allowlist: TxAllowlist;
  /** Called with every transaction that is about to be signed. Persist it. */
  audit: (record: SignAudit) => Promise<void> | void;
  messages?: MessagePolicy;
};

export async function guardedAccount(input: GuardedAccountInput): Promise<LocalAccount> {
  // The /viem subpath ships its own PrivyClient type identity; the runtime
  // object is the same client.
  type ViemPrivy = Parameters<typeof createViemAccount>[0]["privy"];
  const inner = await createViemAccount({
    walletId: input.walletId,
    address: input.address,
    privy: privy() as unknown as ViemPrivy,
  });

  const refuse = (what: string) => async (): Promise<never> => {
    throw new TxNotAllowedError(`${what} signing is disabled for bot wallets`);
  };

  const guarded: LocalAccount = {
    address: inner.address,
    publicKey: inner.publicKey,
    source: inner.source,
    type: "local",
    sign: refuse("raw hash"),
    async signMessage({ message }) {
      const policy = input.messages;
      if (!policy) return refuse("message")();
      // Raw bytes could encode anything, including a hash to be signed blind.
      if (typeof message !== "string") throw new TxNotAllowedError("only a plain-text message can be signed");
      const check = policy.allow(message);
      if (!check.ok) {
        logger.warn({ wallet: input.address, reason: check.reason }, "refused to sign a message");
        throw new TxNotAllowedError(check.reason);
      }
      const bytes = toBytes(message);
      await policy.audit({ kind: check.kind, wallet: input.address, messageHash: keccak256(bytes), bytes: bytes.length });
      return inner.signMessage({ message });
    },
    signTypedData: refuse("typed data"),
    signAuthorization: refuse("EIP-7702 authorization"),
    async signTransaction(tx, options) {
      const check = checkTransaction(input.allowlist, { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value });
      if (!check.ok) {
        logger.warn({ wallet: input.address, to: tx.to, reason: check.reason }, "refused to sign");
        throw new TxNotAllowedError(check.reason);
      }
      const data = (tx.data ?? "0x") as Hex;
      await input.audit({
        kind: check.kind,
        chainId: tx.chainId as number,
        wallet: input.address,
        to: tx.to as Address,
        calldataHash: keccak256(data),
        valueWei: (tx.value ?? 0n).toString(),
      });
      return inner.signTransaction(tx, options);
    },
  };
  return guarded;
}
