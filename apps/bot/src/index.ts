import { alerterFromEnv } from "./alerts";
import "@o1bot/shared/load-env";
import { formatEther, getAddress, isAddress, keccak256, toHex, type Address } from "viem";
import { dbConfigured } from "@o1bot/db";
import { planLaunch, prepareTokenMetadata, type LaunchRequest, type PreparedMetadata, type TokenMetadataInput } from "@o1bot/executor";
import { localizeReply, parseMention } from "@o1bot/parser";
import { activeFactory, activeFeeEscrow, cryptoQuotes, env, logger, o1Chain, o1Config, registryDrift, stockQuotes } from "@o1bot/shared";
import { ensureWalletForXUser, findUserByXUserId, linkStatus, type EnsureWalletInput, type LinkedUser, type LinkStatus } from "@o1bot/wallet";
import { FakeXClient, HttpXClient, type XClient, type XMention } from "@o1bot/x";
import { botConfig, type BotConfig } from "./config";
import { executeLaunchPlan, setCreatorFeeRecipient } from "./execute";
import { liveO1Tokens } from "./o1-tokens";
import { dryRunTradeChain, liveTradeChain } from "./trade-chain";
import { processMention, type PipelineDeps } from "./pipeline";
import { BullQueue, MemoryQueue, type JobQueue } from "./queue";
import { MemoryBotStore, PrismaBotStore, type BotStore } from "./store";
import { drainWebLaunches, startWebLaunchPolling } from "./web-launches";
import { pollOnce, startPolling } from "./x-listener";

/** How often the worker looks for launches submitted through the web form. */
const WEB_LAUNCH_POLL_MS = 5_000;

/**
 * Bot entry point: listener → queue → pipeline.
 *
 *   pnpm --filter @o1bot/bot start          poll X forever
 *   pnpm --filter @o1bot/bot once           one poll, drain the queue, exit
 *   pnpm --filter @o1bot/bot once --mention 'launch $CAT "Cash Cat" pair ETH' --author alice --wallet 0x...
 *                                           feed one synthetic post through the whole pipeline (DRY_RUN only)
 *   pnpm --filter @o1bot/bot once --post <tweet id>
 *                                           process one real post on demand, whoever wrote it, including the
 *                                           bot's own account (the poller never processes the bot's own posts).
 *                                           A previous dry run of the same post is forgotten first; a post that
 *                                           already had a transaction signed is refused. Honours DRY_RUN.
 *
 * Which real services are used depends on the env that is present; every
 * missing one falls back to an in-memory or dry-run stand-in when DRY_RUN
 * is on, and is an error when it is off.
 */

type CliArgs = { once: boolean; mention: string | null; post: string | null; author: string; wallet: Address | null; image: string | null };

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { once: argv.includes("--once"), mention: null, post: null, author: "dryrun_user", wallet: null, image: null };
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  args.mention = value("--mention");
  args.post = value("--post");
  args.author = value("--author") ?? args.author;
  args.image = value("--image");
  const wallet = value("--wallet");
  if (wallet) {
    if (!isAddress(wallet)) throw new Error(`--wallet is not an address: ${wallet}`);
    args.wallet = getAddress(wallet);
  }
  return args;
}

function syntheticMention(args: CliArgs, botHandle: string): XMention {
  const id = String(Date.now());
  const authorId = `dry-${keccak256(toHex(args.author)).slice(2, 12)}`;
  return {
    id,
    text: `@${botHandle} ${args.mention ?? ""}`.trim(),
    authorId,
    authorHandle: args.author,
    authorName: args.author,
    authorImage: null,
    imageUrl: args.image,
    createdAt: new Date().toISOString(),
    lang: null,
    referenced: [],
  };
}

function dryRunMetadata(input: TokenMetadataInput): PreparedMetadata {
  const slug = input.symbol.toLowerCase();
  return {
    uri: `ipfs://dry-run/${slug}.json`,
    imageUri: `ipfs://dry-run/${slug}.png`,
    imageSource: input.imageUrl ? "tweet" : "placeholder",
    imageRejectReason: null,
    json: { name: input.name, symbol: input.symbol, dryRun: true },
    pinnedBy: "o1bot",
  };
}

/** Deterministic stand-in wallet for `fees to` targets when Privy is not configured (dry run only). */
function dryRunRecipient(input: EnsureWalletInput): LinkedUser {
  const address = getAddress(`0x${keccak256(toHex(`o1bot-dry-run:${input.xUserId}`)).slice(26)}`);
  return {
    privyUserId: `dry-${input.xUserId}`,
    xUserId: input.xUserId,
    xHandle: input.username.toLowerCase(),
    xName: input.name ?? null,
    xAvatarUrl: input.avatarUrl ?? null,
    wallet: { address, walletId: null, delegated: false },
    hasLoggedIn: false,
    pregenerated: true,
  };
}

function buildDeps(cfg: BotConfig, args: CliArgs, store: BotStore, x: XClient): PipelineDeps {
  const e = env();
  const privyConfigured = Boolean(e.PRIVY_APP_ID && e.PRIVY_APP_SECRET);
  const pinataConfigured = Boolean(e.PINATA_JWT);
  // Trades need a chain to quote and sign against; without one (DB-less dry runs) a stand-in answers with fixed prices.
  const rpcConfigured = Boolean(e.RPC_ROBINHOOD) || !cfg.dryRun;

  const need = (what: string, envVar: string) => {
    if (!cfg.dryRun) throw new Error(`${envVar} is required when DRY_RUN=false (${what})`);
    logger.warn({ envVar }, `${what} not configured; using a dry-run stand-in`);
  };

  let resolveLink: PipelineDeps["resolveLink"];
  if (privyConfigured) {
    resolveLink = async (xUserId) => linkStatus(await findUserByXUserId(xUserId));
  } else {
    need("Privy user lookup", "PRIVY_APP_ID/PRIVY_APP_SECRET");
    resolveLink = async (xUserId): Promise<LinkStatus> => {
      if (!args.wallet) return { linked: false, reason: "no_account", user: null };
      const user: LinkedUser = {
        privyUserId: `dry-${xUserId}`,
        xUserId,
        xHandle: args.author.toLowerCase(),
        xName: args.author,
        xAvatarUrl: null,
        wallet: { address: args.wallet, walletId: "dry-run", delegated: true },
        hasLoggedIn: true,
        pregenerated: false,
      };
      return { linked: true, user, wallet: user.wallet! };
    };
  }

  let ensureRecipientWallet: PipelineDeps["ensureRecipientWallet"];
  if (privyConfigured) ensureRecipientWallet = ensureWalletForXUser;
  else ensureRecipientWallet = async (input) => dryRunRecipient(input);

  let prepareMetadata: PipelineDeps["prepareMetadata"];
  if (pinataConfigured) prepareMetadata = prepareTokenMetadata;
  else {
    need("IPFS pinning", "PINATA_JWT");
    prepareMetadata = async (input) => dryRunMetadata(input);
  }

  return {
    store,
    x,
    config: cfg,
    parse: (input) => parseMention(input),
    localize: (text, language) => localizeReply(text, language),
    resolveLink,
    ensureRecipientWallet,
    prepareMetadata,
    // The virtual balance only affects simulation; the funding check still reads the real balance,
    // so an underfunded wallet gets an exact shortfall instead of a generic revert.
    plan: (req: LaunchRequest) => planLaunch(req, { fundSimulation: true }),
    execute: (plan, wallet, audit) => executeLaunchPlan(plan, wallet, audit),
    setFeeRecipient: (input, wallet, audit) => setCreatorFeeRecipient(input, wallet, audit),
    trade: rpcConfigured ? liveTradeChain() : dryRunTradeChain(),
    o1Tokens: liveO1Tokens(),
    alerts: cfg.dryRun ? undefined : alerterFromEnv(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = botConfig();
  const e = env();
  const chain = o1Chain("robinhood");
  logger.info(
    {
      dryRun: cfg.dryRun,
      snapshotFetchedAt: o1Config().fetchedAt,
      factory: activeFactory("robinhood"),
      feeEscrow: activeFeeEscrow("robinhood"),
      nativeLaunchFee: `${formatEther(BigInt(chain.snapshot.nativeLaunchFeeRaw))} ETH (snapshot)`,
      cryptoPairs: cryptoQuotes("robinhood").map((q) => q.symbol),
      stockPairs: stockQuotes("robinhood").length,
      pollMs: cfg.pollMs,
      queue: e.QUEUE_DRIVER,
    },
    "o1bot booting",
  );

  // Never build a transaction against a factory o1 no longer selects.
  const drift = await registryDrift();
  if (drift.length > 0) {
    logger.error({ drift }, "config/o1.json is stale: run `pnpm o1:sync` and `pnpm abi:vendor`, then re-verify");
    process.exitCode = 1;
    return;
  }
  logger.info("o1 live registry matches the snapshot");

  if (args.mention && !cfg.dryRun) throw new Error("--mention is only allowed with DRY_RUN=true");

  // Store: Postgres when configured, memory for DB-less dry runs.
  let store: BotStore;
  if (dbConfigured()) store = new PrismaBotStore();
  else if (cfg.dryRun) {
    logger.warn("DATABASE_URL not set; using the in-memory store (nothing is persisted)");
    store = new MemoryBotStore();
  } else throw new Error("DATABASE_URL is required when DRY_RUN=false");

  // X: the real API when a Bearer token exists, else a scripted client fed by --mention.
  let x: XClient;
  const xConfigured = Boolean(e.X_BEARER_TOKEN && e.X_BOT_USER_ID);
  if (args.mention) {
    x = new FakeXClient([syntheticMention(args, cfg.botHandle)]);
    logger.info({ author: args.author, wallet: args.wallet }, "feeding one synthetic mention");
  } else if (xConfigured) x = new HttpXClient();
  else if (cfg.dryRun) {
    logger.warn("X_BEARER_TOKEN/X_BOT_USER_ID not set; nothing to poll. Use --mention to feed a post.");
    x = new FakeXClient();
  } else throw new Error("X_BEARER_TOKEN and X_BOT_USER_ID are required when DRY_RUN=false");
  if (!cfg.dryRun && !(e.X_APP_KEY && e.X_APP_SECRET && e.X_APP_ACCESS_TOKEN && e.X_APP_ACCESS_TOKEN_SECRET)) {
    throw new Error("X_APP_KEY, X_APP_SECRET, X_APP_ACCESS_TOKEN and X_APP_ACCESS_TOKEN_SECRET are required to post replies when DRY_RUN=false");
  }

  const queue: JobQueue = e.QUEUE_DRIVER === "redis" ? new BullQueue(env().REDIS_URL ?? (() => { throw new Error("REDIS_URL is required when QUEUE_DRIVER=redis"); })()) : new MemoryQueue();
  const deps = buildDeps(cfg, args, store, x);
  queue.start(async (job) => {
    const outcome = await processMention(job.mention, deps);
    logger.info({ tweetId: job.mention.id, ...outcome }, "mention processed");
  });

  const listener = { x, store, queue, botUserId: cfg.botUserId };

  if (args.post) {
    // Operator path: one specific post, no author filter, no cursor movement.
    const post = await x.fetchPost(args.post);
    if (!post) throw new Error(`post ${args.post} was not found or is not visible to the app`);
    const reset = await store.resetMentionForRerun(post.id);
    if (!reset.reset && reset.reason !== "never processed") throw new Error(`refusing to process post ${post.id}: ${reset.reason}`);
    logger.warn(
      { tweetId: post.id, author: post.authorHandle, ownPost: post.authorId === cfg.botUserId, dryRun: cfg.dryRun, previous: reset.reason },
      cfg.dryRun ? "processing one post in dry run: nothing will be signed or posted" : "processing one post LIVE: the author's wallet will sign and the bot will reply",
    );
    const result = await queue.enqueue({ mention: post });
    if (result === "duplicate") throw new Error(`post ${post.id} is already queued`);
    await queue.drain();
    await queue.close();
    logger.info("done");
    return;
  }

  if (args.once || args.mention) {
    const stats = await pollOnce(listener);
    logger.info(stats, "single poll done; draining the queue");
    await queue.drain();
    const webRan = await drainWebLaunches(deps);
    if (webRan) logger.info({ webRan }, "web launches processed");
    await queue.close();
    logger.info("done");
    return;
  }

  const poller = startPolling({ ...listener, alerts: deps.alerts }, cfg.pollMs);
  const webPoller = startWebLaunchPolling(deps, WEB_LAUNCH_POLL_MS);
  deps.alerts?.send({ kind: "boot", title: "o1bot is up", fields: [["Factory", activeFactory("robinhood")], ["Poll", `${cfg.pollMs} ms`], ["Queue", e.QUEUE_DRIVER]] });
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await Promise.all([poller.stop(), webPoller.stop()]);
    await queue.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "bot crashed");
  try {
    alerterFromEnv().send({ kind: "crash", title: "o1bot crashed", fields: [["Error", err instanceof Error ? err.message : String(err)]] });
  } catch {
    // Alerts are best effort even here.
  }
  setTimeout(() => process.exit(1), 1500);
});
