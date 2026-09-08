import { decodeFunctionData, getAddress, isAddress, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";

/**
 * The bot signs ONLY these transaction kinds, and only to known o1 contracts
 * (or an ERC-20 quote token for an approval). Anything else is refused before
 * it reaches Privy. A tweet can never turn into arbitrary calldata.
 */
export const ALLOWED_TX_KINDS = [
  "createLaunch",
  "createLaunchAndBuy",
  "erc20Approve",
  "setCreatorFeeRecipient",
  "feeClaimFor",
  "feeClaimTo",
] as const;
export type AllowedTxKind = (typeof ALLOWED_TX_KINDS)[number];

/**
 * Function signatures per o1's "Functions and events" and "Direct contract
 * integration" pages (fetched 2026-09-06). The launch tuple layout is the
 * documented `LaunchParams`; step 2 re-derives these selectors from the
 * verified explorer ABI vendored under `abis/`. If a signature here is wrong
 * the guard fails closed (rejects); it never lets something else through.
 */
const LAUNCH_PARAMS = "(string,string,string,bytes32,address,uint64,uint64,bool,string[],string[])";
const LAUNCH_BUY_PARAMS = "(address,uint256,uint256,bytes)";

export const TX_SIGNATURES: Record<AllowedTxKind, string> = {
  createLaunch: `createLaunch(${LAUNCH_PARAMS})`,
  createLaunchAndBuy: `createLaunchAndBuy(${LAUNCH_PARAMS},${LAUNCH_BUY_PARAMS})`,
  erc20Approve: "approve(address,uint256)",
  setCreatorFeeRecipient: "setCreatorFeeRecipient(address,address)",
  feeClaimFor: "claimFor(address,address)",
  feeClaimTo: "claimTo(address,address)",
};

export const TX_SELECTORS: Record<AllowedTxKind, Hex> = Object.fromEntries(
  ALLOWED_TX_KINDS.map((kind) => [kind, toFunctionSelector(TX_SIGNATURES[kind])]),
) as Record<AllowedTxKind, Hex>;

/** Full ABI of the allowed surface, so calldata is decoded, not just selector-matched. */
const TX_ABI = parseAbi(ALLOWED_TX_KINDS.map((kind) => `function ${TX_SIGNATURES[kind]}`));

export type AllowlistEntry = {
  kind: AllowedTxKind;
  to: Address;
  /** For `erc20Approve`: the only spenders an approval may name. */
  spenders?: Address[];
};
export type TxAllowlist = { chainId: number; entries: AllowlistEntry[] };

export function buildAllowlist(input: {
  chainId: number;
  factory: Address;
  feeEscrow: Address;
  /** ERC-20 quote tokens an approval may target (never native). */
  approvalTargets?: Address[];
  /** Contracts an approval may name as spender; the factory alone by default. */
  approvalSpenders?: Address[];
}): TxAllowlist {
  const entries: AllowlistEntry[] = [
    { kind: "createLaunch", to: getAddress(input.factory) },
    { kind: "createLaunchAndBuy", to: getAddress(input.factory) },
    { kind: "setCreatorFeeRecipient", to: getAddress(input.factory) },
    { kind: "feeClaimFor", to: getAddress(input.feeEscrow) },
    { kind: "feeClaimTo", to: getAddress(input.feeEscrow) },
  ];
  const spenders = (input.approvalSpenders ?? [input.factory]).map((a) => getAddress(a));
  for (const token of input.approvalTargets ?? []) {
    entries.push({ kind: "erc20Approve", to: getAddress(token), spenders });
  }
  return { chainId: input.chainId, entries };
}

export type TxCheck = { ok: true; kind: AllowedTxKind; selector: Hex } | { ok: false; reason: string };

export type TxLike = {
  chainId?: number | undefined;
  to?: Address | string | null | undefined;
  data?: Hex | string | undefined;
};

export function checkTransaction(allowlist: TxAllowlist, tx: TxLike): TxCheck {
  if (tx.chainId === undefined) return { ok: false, reason: "transaction has no chainId" };
  if (tx.chainId !== allowlist.chainId) {
    return { ok: false, reason: `chainId ${tx.chainId} is not the allow-listed chain ${allowlist.chainId}` };
  }
  if (!tx.to) return { ok: false, reason: "contract creation is not allowed" };
  if (!isAddress(tx.to)) return { ok: false, reason: "malformed to-address" };
  const to = getAddress(tx.to);
  const data = (tx.data ?? "0x") as string;
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) {
    return { ok: false, reason: "plain value transfers and calls without a selector are not allowed" };
  }
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const entry = allowlist.entries.find((e) => e.to === to && TX_SELECTORS[e.kind] === selector);
  if (!entry) return { ok: false, reason: `selector ${selector} to ${to} is not allow-listed` };

  // The selector says which function; the arguments must decode as that
  // function too, so truncated or padded calldata never gets a signature.
  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: TX_ABI, data: data as Hex });
    args = decoded.args ?? [];
  } catch {
    return { ok: false, reason: `calldata does not decode as ${TX_SIGNATURES[entry.kind]}` };
  }

  // An approval is only ever for the contract that will pull the tokens.
  if (entry.kind === "erc20Approve") {
    const spender = args[0];
    if (typeof spender !== "string" || !isAddress(spender)) return { ok: false, reason: "approve spender is not an address" };
    if (!(entry.spenders ?? []).includes(getAddress(spender))) {
      return { ok: false, reason: `approve spender ${getAddress(spender)} is not allow-listed` };
    }
  }
  return { ok: true, kind: entry.kind, selector };
}
