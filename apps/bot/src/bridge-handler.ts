import { parseEther } from "viem";
import type { BridgeCommand } from "@o1bot/parser";
import { runBridge } from "./bridge-core";
import type { WalletRef } from "./execute";
import type { MentionContext, PipelineOutcome } from "./pipeline";
import { replies } from "./replies";

/**
 * The bridge branch of the pipeline: the poster must be linked, then the
 * bridge core quotes Relay, signs the deposit on the origin chain from the
 * poster's wallet and waits for the fill; this maps the result onto replies
 * and mention statuses.
 */
export async function handleBridge(cmd: BridgeCommand, ctx: MentionContext): Promise<PipelineOutcome> {
  const { mention, mentionId, deps, now, log, reply, setMention } = ctx;
  const { store, config } = deps;

  const link = await deps.resolveLink(mention.authorId);
  if (!link.linked) {
    log.info({ reason: link.reason }, "poster is not registered");
    const r = await reply(replies.notRegistered(config.siteUrl));
    await setMention("NOT_REGISTERED", { error: link.reason });
    return { outcome: "replied", kind: "not_registered", reply: r.posted || config.dryRun ? r.text : null };
  }
  const wallet: WalletRef = { walletId: link.wallet.walletId!, address: link.wallet.address };
  const handle = mention.authorHandle || link.user.xHandle || "unknown";
  const user = await store.upsertUser({
    xUserId: mention.authorId,
    xHandle: handle,
    xName: mention.authorName ?? link.user.xName,
    xAvatarUrl: mention.authorImage ?? link.user.xAvatarUrl,
    privyUserId: link.user.privyUserId,
    walletAddress: wallet.address,
    walletId: wallet.walletId,
    pregenerated: false,
    delegated: true,
  });

  let amountWei: bigint;
  try {
    amountWei = parseEther(cmd.amount);
  } catch {
    amountWei = 0n;
  }
  await setMention("QUEUED");
  const result = await runBridge(
    { mentionId, tweetId: mention.id, userId: user.id, xUserId: mention.authorId, handle, wallet, originKey: cmd.fromChain, amountWei, forBuy: false },
    { store, config, bridge: deps.bridge, relay: deps.relay, alerts: deps.alerts, now },
    log,
  );

  if (!result.ok) {
    const r = await reply(result.userText);
    if (result.outcome === "rejected") {
      await setMention("REJECTED", { error: result.error });
      return { outcome: "replied", kind: "rejected", reply: r.posted || config.dryRun ? r.text : null };
    }
    await setMention("FAILED", { error: result.error });
    return { outcome: "failed", error: result.error, reply: r.posted || config.dryRun ? r.text : null, launchId: null };
  }
  if (result.dryRun) {
    const r = await reply(result.userText);
    await setMention("DONE");
    return { outcome: "bridge_dry_run", bridgeId: result.bridgeId, reply: r.text };
  }
  const r = await reply(result.userText);
  await setMention(r.posted ? "DONE" : "FAILED", r.posted ? {} : { error: r.error ?? "reply not posted" });
  return { outcome: "bridged", bridgeId: result.bridgeId, depositTxHash: result.depositTxHash, fillTxHash: result.fillTxHash, reply: r.posted ? r.text : null };
}
