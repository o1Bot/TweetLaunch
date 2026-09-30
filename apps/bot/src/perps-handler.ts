import type { PerpCommand } from "@o1bot/parser";
import { runPerp } from "./perps-core";
import type { MentionContext, PipelineOutcome } from "./pipeline";
import { replies } from "./replies";

/**
 * The perp branch of the pipeline. Whether the poster may trade is decided by
 * their opt-in row (the PerpsAccount the terminal created and the worker
 * registered a key for), not by the launch wallet link: the account on the
 * venue and the bot's key on it are what an order needs.
 */
export async function handlePerp(cmd: PerpCommand, ctx: MentionContext): Promise<PipelineOutcome> {
  const { mention, mentionId, deps, now, log, reply, setMention } = ctx;
  const { config } = deps;

  if (!deps.perps) {
    const r = await reply(replies.perpsUnavailable(config.perpsSiteUrl));
    await setMention("REJECTED", { error: "perps from a post are not configured on this deployment" });
    return { outcome: "replied", kind: "rejected", reply: r.posted || config.dryRun ? r.text : null };
  }

  await setMention("QUEUED");
  const result = await runPerp(
    { mentionId, tweetId: mention.id, xUserId: mention.authorId, handle: mention.authorHandle || "unknown", cmd },
    { store: deps.perps.store, venue: deps.perps.venue, config, alerts: deps.alerts, now },
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
    return { outcome: "perp_dry_run", orderId: result.orderId, reply: r.text };
  }
  const r = await reply(result.userText);
  if (r.posted) await setMention("DONE");
  else await setMention("FAILED", { error: r.error ?? "reply not posted" });
  return { outcome: "perp_order", orderId: result.orderId, txHash: result.txHash, filled: result.filled, reply: r.posted ? r.text : null };
}
