import type { TradeCommand } from "@o1bot/parser";
import type { WalletRef } from "./execute";
import type { MentionContext, PipelineOutcome } from "./pipeline";
import { replies } from "./replies";
import { runTrade } from "./trade-core";

/**
 * The trade branch of the pipeline: the poster must be linked (X login,
 * embedded wallet, signer with the policy), then the shared trade core does
 * the rest and this maps its result onto replies and mention statuses.
 */
export async function handleTrade(cmd: TradeCommand, ctx: MentionContext): Promise<PipelineOutcome> {
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

  await setMention("QUEUED");
  const result = await runTrade({ mentionId, tweetId: mention.id, userId: user.id, xUserId: mention.authorId, handle, wallet, cmd }, { store, config, trade: deps.trade, now }, log);

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
    return { outcome: "trade_dry_run", tradeId: result.tradeId, reply: r.text };
  }
  const r = await reply(result.userText);
  if (r.posted) {
    await store.updateTrade(result.tradeId, { status: "REPLIED" });
    await setMention("DONE");
  } else {
    await setMention("FAILED", { error: r.error ?? "reply not posted" });
  }
  return { outcome: "traded", tradeId: result.tradeId, txHash: result.txHash, reply: r.posted ? r.text : null };
}
