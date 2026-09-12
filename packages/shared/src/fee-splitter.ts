import { getAddress, isAddress, parseAbi, type Address } from "viem";
import type { ChainKey } from "./chains";
import { env } from "./env";

/**
 * o1bot's FeeSplitter (packages/contracts): one clone per launch, set as
 * o1's creator fee recipient. The clone pulls the launch's creator fees from
 * o1's escrow and pays the recipients and the platform treasury in one
 * transaction. Its address follows from its configuration, so the bot can
 * pass it to o1 before the clone exists.
 */

export const FEE_SPLIT_BPS = 10_000;

/** A clone's configuration: recipients with their shares (basis points, summing to 10 000) and the platform share. */
export type FeeSplitConfig = { recipients: Address[]; shares: number[]; platformBps: number };

export const feeSplitterFactoryAbi = parseAbi([
  "function platformBps() view returns (uint16)",
  "function treasury() view returns (address)",
  "function o1Escrow() view returns (address)",
  "function implementation() view returns (address)",
  "function predict(address token, address[] recipients, uint16[] shares, uint16 platformBps) view returns (address)",
  "function register(address token, address[] recipients, uint16[] shares) returns (address)",
  "function registerWith(address token, address[] recipients, uint16[] shares, uint16 platformBps) returns (address)",
  "event Registered(address indexed splitter, address indexed token, address[] recipients, uint16[] shares, uint16 platformBps)",
]);

export const feeSplitterAbi = parseAbi([
  "function claim(address currency) returns (uint256)",
  "function claimable(address currency) view returns (uint256)",
  "function pending(address currency, address account) view returns (uint256)",
  "function totalPending(address currency) view returns (uint256)",
  "function withdraw(address currency)",
  "function token() view returns (address)",
  "function recipients() view returns (address[])",
  "function shares() view returns (uint16[])",
  "function platformBps() view returns (uint16)",
  "event Claimed(address indexed currency, uint256 distributed, uint256 platformAmount)",
]);

/**
 * o1bot's FeeSplitterFactory on a chain (packages/contracts), or null where
 * none is deployed: launches there keep the creator's wallet as o1's fee
 * recipient, as before the splitter existed.
 */
export function feeSplitterFactory(key: ChainKey): Address | null {
  const e = env();
  const raw = key === "robinhood" ? e.FEE_SPLITTER_FACTORY_ROBINHOOD : key === "base" ? e.FEE_SPLITTER_FACTORY_BASE : e.FEE_SPLITTER_FACTORY_ARC;
  return raw ? getAddress(raw) : null;
}

/** One recipient with everything: the creator, or the account named by "fees to". */
export function soleRecipient(recipient: Address): Pick<FeeSplitConfig, "recipients" | "shares"> {
  return { recipients: [getAddress(recipient)], shares: [FEE_SPLIT_BPS] };
}

/** The recipients' share of the creator fees after the platform's, in whole percent (80 for 2000 bps). */
export function recipientSharePct(platformBps: number): number {
  return Math.round(((FEE_SPLIT_BPS - platformBps) * 100) / FEE_SPLIT_BPS);
}

/** The recipients' part of a gross creator-fee amount: what is left after the platform's share, computed as the clone does. */
export function recipientShareOf(amount: bigint, platformBps: number): bigint {
  return amount - (amount * BigInt(platformBps)) / BigInt(FEE_SPLIT_BPS);
}

/**
 * The configuration a Launch row stores (a JSON column), or null when the
 * row has none or it is malformed: the web app and the bot only claim from
 * a clone whose configuration they can reproduce.
 */
export function parseFeeSplitConfig(value: unknown): FeeSplitConfig | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Record<keyof FeeSplitConfig, unknown>>;
  if (!Array.isArray(v.recipients) || !Array.isArray(v.shares) || typeof v.platformBps !== "number") return null;
  if (v.recipients.length === 0 || v.recipients.length !== v.shares.length) return null;
  if (!v.recipients.every((r): r is string => typeof r === "string" && isAddress(r))) return null;
  if (!v.shares.every((s): s is number => typeof s === "number" && Number.isInteger(s) && s >= 0)) return null;
  if (v.shares.reduce((a, b) => a + b, 0) !== FEE_SPLIT_BPS) return null;
  if (!Number.isInteger(v.platformBps) || v.platformBps < 0 || v.platformBps > FEE_SPLIT_BPS) return null;
  return { recipients: v.recipients.map((r) => getAddress(r)), shares: [...v.shares], platformBps: v.platformBps };
}
