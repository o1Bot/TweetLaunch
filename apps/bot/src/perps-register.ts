import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db } from "@o1bot/db";
import {
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  TX_TYPE_L2_CHANGE_PUB_KEY,
  createLighterClient,
  isSignerError,
  loadSignerFromBytes,
  lookupAccount,
  parseRegisterMessage,
  sealWithSecret,
  type LighterSignerGlobals,
  type LinkStatus,
  type RegisterMessage,
} from "@o1bot/lighter";
import { DEFAULT_CHAIN_KEY, activeFactory, activeFeeEscrow, buildAllowlist, chainByKey, logger } from "@o1bot/shared";
import { guardedAccount } from "@o1bot/wallet";

/**
 * Trading perps from a post, part one: the key.
 *
 * An order from a post is signed while the user is not there, so the bot needs
 * its own API key on the user's Lighter account. This worker registers one for
 * every account whose owner opted in on perps.o1bot.exchange (a PerpsAccount
 * row in PENDING), in the bot's own slot, and seals the private key with the
 * bot's vault secret. The registration itself is the venue's ChangePubKey: the
 * user's Privy wallet signs "Register Lighter Account …" and the venue checks
 * that signature against the account's owner. Privy's policy lets that wallet
 * sign nothing else, and the message policy in packages/wallet checks the
 * account, slot and key named inside the message before asking.
 *
 * What a registered key can do is trade and withdraw — to the owner's own L1
 * address, nowhere else — so the blast radius of a stolen vault is each opted
 * in user's collateral, never a transfer out. Which is still why the vault
 * secret lives only on the bot.
 */

export type RegisterRow = {
  id: string;
  xUserId: string;
  walletAddress: string;
  /** Privy server-wallet id; without it nothing can sign for the wallet. */
  walletId: string;
  apiKeyIndex: number;
  /** The key an earlier attempt sealed and may already have registered. */
  publicKey: string | null;
  sealedKey: string | null;
};

export type RegisterExpectation = { accountIndex: bigint; apiKeyIndex: number; pubKey: string };

export type RegisterDeps = {
  lookup: (address: string) => Promise<LinkStatus>;
  /** Who holds the slot on the account, or null when it is free. */
  slot: (accountIndex: number, apiKeyIndex: number) => Promise<{ public_key: string } | null>;
  nextNonce: (accountIndex: number, apiKeyIndex: number) => Promise<{ nonce: number }>;
  sendTx: (txType: number, txInfo: string) => Promise<unknown>;
  signer: () => Promise<Pick<LighterSignerGlobals, "GenerateAPIKey" | "CreateClient" | "SignChangePubKey">>;
  seal: (privateKey: string) => Promise<string>;
  /** Persists the sealed key. Called before anything is broadcast, never after. */
  save: (patch: { accountIndex: bigint; publicKey: string; sealedKey: string }) => Promise<void>;
  /** The user's wallet signs the venue's message, behind the message policy. */
  signMessage: (wallet: { walletId: string; address: string }, message: string, expect: RegisterExpectation) => Promise<string>;
  dryRun: boolean;
};

export type RegisterOutcome =
  | { ok: true; accountIndex: bigint; publicKey: string; txHash: string | null; already: boolean }
  | { ok: false; error: string; retry: boolean };

const sameKey = (a: string, b: string) => a.toLowerCase().replace(/^0x/, "") === b.toLowerCase().replace(/^0x/, "");

/** True when the venue's message registers exactly the key, slot and account this attempt is about. */
export function registrationMatches(parsed: RegisterMessage, expect: RegisterExpectation): boolean {
  return parsed.accountIndex === expect.accountIndex && parsed.apiKeyIndex === expect.apiKeyIndex && sameKey(parsed.pubKey, expect.pubKey);
}

/**
 * Register the bot's key on one account. Pure apart from `deps`, so the order
 * of operations — which is the whole safety argument — is testable.
 */
export async function registerPerpsKey(row: RegisterRow, deps: RegisterDeps): Promise<RegisterOutcome> {
  const link = await deps.lookup(row.walletAddress);
  if (link.state === "error") return { ok: false, error: `the venue did not answer: ${link.message}`, retry: true };
  if (link.state === "none") {
    return { ok: false, error: "no Lighter account for this wallet yet — deposit once on perps.o1bot.exchange, then enable again", retry: false };
  }
  if (link.state === "unusable") return { ok: false, error: "this wallet's Lighter accounts are not standard trading accounts", retry: false };
  const accountIndex = link.account.index;

  // A slot holds one key and ChangePubKey replaces it silently. Never write
  // over something that is not ours.
  const occupant = await deps.slot(accountIndex, row.apiKeyIndex);
  if (occupant) {
    if (row.publicKey && row.sealedKey && sameKey(occupant.public_key, row.publicKey)) {
      // An earlier attempt broadcast and lost the answer; the slot already holds our key.
      return { ok: true, accountIndex: BigInt(accountIndex), publicKey: row.publicKey, txHash: null, already: true };
    }
    return {
      ok: false,
      error: `slot ${row.apiKeyIndex} on Lighter account ${accountIndex} already holds another client's key; o1bot will not replace it`,
      retry: false,
    };
  }

  const signer = await deps.signer();
  const generated = signer.GenerateAPIKey();
  if (isSignerError(generated)) return { ok: false, error: `could not generate a key: ${generated.error}`, retry: true };
  const { privateKey, publicKey } = generated;

  // Seal and persist BEFORE the broadcast. The other order has a failure that
  // cannot be undone: a registration that lands while the key was never
  // stored leaves the slot holding a key nobody can sign with.
  const sealedKey = await deps.seal(privateKey);
  await deps.save({ accountIndex: BigInt(accountIndex), publicKey, sealedKey });

  const created = signer.CreateClient(DEFAULT_BASE_URL, privateKey, L2_CHAIN_ID, row.apiKeyIndex, accountIndex);
  if (isSignerError(created)) return { ok: false, error: `could not create a signing client: ${created.error}`, retry: true };
  const { nonce } = await deps.nextNonce(accountIndex, row.apiKeyIndex);
  const tx = signer.SignChangePubKey(publicKey, 0, nonce, row.apiKeyIndex, accountIndex);
  if (isSignerError(tx)) return { ok: false, error: `could not sign the registration: ${tx.error}`, retry: true };
  if (tx.txType !== TX_TYPE_L2_CHANGE_PUB_KEY) {
    return { ok: false, error: `signer produced tx type ${tx.txType}, expected a registration (${TX_TYPE_L2_CHANGE_PUB_KEY})`, retry: false };
  }
  if (!tx.messageToSign) return { ok: false, error: "signer returned no message for the wallet to sign", retry: false };

  const expect: RegisterExpectation = { accountIndex: BigInt(accountIndex), apiKeyIndex: row.apiKeyIndex, pubKey: publicKey };
  const parsed = parseRegisterMessage(tx.messageToSign);
  if (!parsed || !registrationMatches(parsed, expect)) {
    return { ok: false, error: "the registration message names a different account, slot or key than the one being registered", retry: false };
  }

  const l1Sig = await deps.signMessage({ walletId: row.walletId, address: row.walletAddress }, tx.messageToSign, expect);
  // The venue recovers the signer from L1Sig over messageToSign and checks it
  // against the account's owner; the field goes back into the same payload.
  const payload = JSON.parse(tx.txInfo) as Record<string, unknown>;
  payload.L1Sig = l1Sig;

  if (deps.dryRun) {
    logger.info({ accountIndex, apiKeyIndex: row.apiKeyIndex, txHash: tx.txHash }, "dry run: would register the bot's key");
    return { ok: true, accountIndex: BigInt(accountIndex), publicKey, txHash: null, already: false };
  }
  await deps.sendTx(tx.txType, JSON.stringify(payload));
  return { ok: true, accountIndex: BigInt(accountIndex), publicKey, txHash: tx.txHash, already: false };
}

// ---------------------------------------------------------------------------
// The live dependencies.

const signerDir = new URL("../../perps/public/signer/", import.meta.url);
let wasmBytes: Promise<Buffer> | undefined;

async function liveSigner(): Promise<LighterSignerGlobals> {
  wasmBytes ??= readFile(fileURLToPath(new URL("lighter-signer.wasm", signerDir)));
  return loadSignerFromBytes({
    wasm: await wasmBytes,
    // wasm_exec.js is a classic script that installs globalThis.Go; importing it runs it.
    installGo: async () => {
      await import(pathToFileURL(fileURLToPath(new URL("wasm_exec.js", signerDir))).href);
    },
  });
}

export function perpsRegisterDeps(opts: { vaultKey: string; dryRun: boolean }): RegisterDeps {
  const client = createLighterClient();
  return {
    lookup: (address) => lookupAccount(client, address),
    slot: (accountIndex, apiKeyIndex) => client.apiKey(accountIndex, apiKeyIndex),
    nextNonce: (accountIndex, apiKeyIndex) => client.nextNonce(accountIndex, apiKeyIndex),
    sendTx: (txType, txInfo) => client.sendTx(txType, txInfo),
    signer: liveSigner,
    seal: (privateKey) => sealWithSecret(privateKey, opts.vaultKey),
    save: async () => {
      throw new Error("save is bound per row by the worker");
    },
    signMessage: async (wallet, message, expect) => {
      const key = DEFAULT_CHAIN_KEY;
      const account = await guardedAccount({
        walletId: wallet.walletId,
        address: wallet.address as `0x${string}`,
        // Required by the guard; nothing here signs a transaction.
        allowlist: buildAllowlist({ chainId: chainByKey(key).id, factory: activeFactory(key), feeEscrow: activeFeeEscrow(key) }),
        audit: async () => {
          throw new Error("the registration worker signs messages, never transactions");
        },
        messages: {
          allow: (m) => {
            const parsed = parseRegisterMessage(m);
            if (!parsed) return { ok: false, reason: "not a Lighter registration message" };
            if (!registrationMatches(parsed, expect)) return { ok: false, reason: "registration message names a different account, slot or key" };
            return { ok: true, kind: "lighter-register" };
          },
          audit: (record) => {
            logger.info({ ...record, accountIndex: expect.accountIndex.toString(), apiKeyIndex: expect.apiKeyIndex }, "signing a Lighter key registration");
          },
        },
      });
      return account.signMessage({ message });
    },
    dryRun: opts.dryRun,
  };
}

// ---------------------------------------------------------------------------
// The worker: claim, register, record.

/** A registration a worker started this long ago and never finished is treated as lost. */
const STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export async function recoverStaleRegistrations(now = new Date()): Promise<number> {
  const stale = await db().perpsAccount.findMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_MS) } },
    select: { id: true, attempts: true },
  });
  for (const row of stale) {
    if (row.attempts < MAX_ATTEMPTS) await db().perpsAccount.update({ where: { id: row.id }, data: { status: "PENDING", startedAt: null } });
    else await db().perpsAccount.update({ where: { id: row.id }, data: { status: "FAILED", error: `worker lost after ${row.attempts} attempts` } });
  }
  if (stale.length) logger.warn({ ids: stale.map((r) => r.id) }, "stale perps registrations recovered");
  return stale.length;
}

async function claim(now: Date) {
  const candidate = await db().perpsAccount.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } });
  if (!candidate) return null;
  const claimed = await db().perpsAccount.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: now, attempts: { increment: 1 } },
  });
  return claimed.count === 1 ? { ...candidate, attempts: candidate.attempts + 1 } : null;
}

/** Register keys for opted-in accounts, oldest first. Returns how many ran. */
export async function drainPerpsRegistrations(deps: RegisterDeps, max = 5, now = () => new Date()): Promise<number> {
  let ran = 0;
  while (ran < max) {
    const row = await claim(now());
    if (!row) break;
    ran++;
    const log = logger.child({ perpsAccount: row.id, xUserId: row.xUserId });
    const user = await db().user.findUnique({ where: { xUserId: row.xUserId }, select: { walletId: true } });
    if (!user?.walletId) {
      await db().perpsAccount.update({ where: { id: row.id }, data: { status: "FAILED", error: "this wallet cannot be signed for by o1bot" } });
      continue;
    }
    try {
      const outcome = await registerPerpsKey(
        { id: row.id, xUserId: row.xUserId, walletAddress: row.walletAddress, walletId: user.walletId, apiKeyIndex: row.apiKeyIndex, publicKey: row.publicKey, sealedKey: row.sealedKey },
        {
          ...deps,
          save: async (patch) => {
            await db().perpsAccount.update({ where: { id: row.id }, data: { accountIndex: patch.accountIndex, publicKey: patch.publicKey, sealedKey: patch.sealedKey } });
          },
        },
      );
      if (outcome.ok) {
        await db().perpsAccount.update({
          where: { id: row.id },
          data: { status: "ACTIVE", accountIndex: outcome.accountIndex, publicKey: outcome.publicKey, registerTxHash: outcome.txHash, activatedAt: now(), error: null },
        });
        log.info({ accountIndex: outcome.accountIndex.toString(), txHash: outcome.txHash, already: outcome.already, dryRun: deps.dryRun }, "perps key registered");
      } else {
        const again = outcome.retry && row.attempts < MAX_ATTEMPTS;
        await db().perpsAccount.update({ where: { id: row.id }, data: { status: again ? "PENDING" : "FAILED", error: outcome.error.slice(0, 1000), startedAt: null } });
        log.warn({ error: outcome.error, again }, "perps key registration did not complete");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db().perpsAccount.update({ where: { id: row.id }, data: { status: row.attempts < MAX_ATTEMPTS ? "PENDING" : "FAILED", error: `worker: ${message.slice(0, 900)}`, startedAt: null } }).catch(() => undefined);
      log.error({ err: message }, "perps key registration crashed");
    }
  }
  return ran;
}

export type PerpsRegisterPoller = { stop(): Promise<void> };

export function startPerpsRegisterPolling(deps: RegisterDeps, pollMs: number): PerpsRegisterPoller {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    try {
      await recoverStaleRegistrations();
      await drainPerpsRegistrations(deps);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "perps registration poll failed; retrying next tick");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        inFlight = tick();
      }, pollMs);
    }
  };
  inFlight = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
