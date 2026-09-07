import { formatEther, parseEther } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { logger, o1Chain } from "@o1bot/shared";
import { balancesAllChains, linkStatus, userFromRequest } from "@o1bot/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gas headroom we ask users to keep on top of the creation fee. */
const GAS_HEADROOM_WEI = parseEther("0.0005");

/**
 * GET /api/me — the signed-in user's X identity, embedded wallet, delegation
 * state and native balances on both chains. Also mirrors the user into
 * Postgres so the bot's validator can answer "is this X account linked?"
 * without calling Privy on every mention.
 */
export async function GET(req: Request) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const status = linkStatus(user);
  const balances = user.wallet ? await balancesAllChains(user.wallet.address) : [];

  // Snapshot value for display only; the executor reads the live fee before signing.
  const creationFeeWei = BigInt(o1Chain("robinhood").snapshot.nativeLaunchFeeRaw);

  if (dbConfigured()) {
    try {
      await db().user.upsert({
        where: { xUserId: user.xUserId },
        create: {
          xUserId: user.xUserId,
          xHandle: user.xHandle ?? "",
          xName: user.xName,
          xAvatarUrl: user.xAvatarUrl,
          privyUserId: user.privyUserId,
          walletAddress: user.wallet?.address ?? null,
          walletId: user.wallet?.walletId ?? null,
          pregenerated: user.pregenerated,
          delegated: user.wallet?.delegated ?? false,
          linkedAt: user.hasLoggedIn ? new Date() : null,
        },
        update: {
          xHandle: user.xHandle ?? "",
          xName: user.xName,
          xAvatarUrl: user.xAvatarUrl,
          privyUserId: user.privyUserId,
          walletAddress: user.wallet?.address ?? null,
          walletId: user.wallet?.walletId ?? null,
          pregenerated: user.pregenerated,
          delegated: user.wallet?.delegated ?? false,
          ...(user.hasLoggedIn ? { linkedAt: new Date() } : {}),
        },
      });
    } catch (err) {
      logger.error({ err, xUserId: user.xUserId }, "user upsert failed");
    }
  } else {
    logger.warn("DATABASE_URL not set; /api/me is not persisting users");
  }

  return Response.json({
    xUserId: user.xUserId,
    xHandle: user.xHandle,
    wallet: user.wallet,
    linked: status.linked,
    reason: status.linked ? null : status.reason,
    balances,
    creationFeeEth: formatEther(creationFeeWei),
    requiredEth: formatEther(creationFeeWei + GAS_HEADROOM_WEI),
  });
}
