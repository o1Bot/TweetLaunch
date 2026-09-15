import { getAddress, isAddress } from "viem";

/** An account as the site shows it: a wallet, with its X account when we know one. */
export type Account = { wallet: string; xHandle: string | null; xName: string | null; xAvatarUrl: string | null };

/**
 * Where a token's creator fees go, for display: the account that receives
 * them, whether that is someone other than the account that launched the
 * token, the recipients' share when o1bot's fee splitter sits in between,
 * and whether the answer was checked against o1's factory on chain.
 */
export type FeeTo = Account & { isOther: boolean; sharePct: number | null; verified: boolean };

export type FeeToInput = {
  creator: Account;
  /** The account a "fees to" launch named, from our launch record. */
  named: Account | null;
  /** o1bot's fee splitter clone for the launch and the recipients' share through it. */
  splitter: { address: string; sharePct: number } | null;
  /** Whether our record holds a confirmed transaction pointing o1's fee recipient away from the creator (to the splitter or the named account). */
  pointed: boolean;
  /** o1's creatorFeeRecipient for the token, read on chain; null when it was not read or the read failed. */
  onChain: string | null;
};

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && getAddress(a.toLowerCase()) === getAddress(b.toLowerCase()));

/**
 * Who gets the fees. o1's factory says who does, and wins when it was read:
 * a creator can point the fees somewhere else on o1 after the launch. Without
 * that read, our record decides, and a "fees to" account or a splitter only
 * counts once the transaction that pointed the fees at it confirmed; until
 * then o1 still pays the creator.
 */
export function resolveFeeTo({ creator, named, splitter, pointed, onChain }: FeeToInput): FeeTo {
  const payee = named ?? creator;
  const shown = (account: Account, sharePct: number | null, verified: boolean): FeeTo => ({ ...account, isOther: !same(account.wallet, creator.wallet), sharePct, verified });
  if (!onChain) return pointed ? shown(payee, splitter?.sharePct ?? null, false) : shown(creator, null, false);
  if (splitter && same(onChain, splitter.address)) return shown(payee, splitter.sharePct, true);
  if (named && same(onChain, named.wallet)) return shown(named, null, true);
  if (same(onChain, creator.wallet)) return shown(creator, null, true);
  return shown({ wallet: getAddress(onChain.toLowerCase()), xHandle: null, xName: null, xAvatarUrl: null }, null, true);
}
