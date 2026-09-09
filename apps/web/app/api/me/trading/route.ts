import { formatEther, parseEther } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { env, logger } from "@o1bot/shared";
import { userFromRequest } from "@o1bot/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me/trading  → the user's opt-in for buy/sell/bridge commands from posts, their per-trade cap,
 *                        whether they accept `fees to @them`, and the reply language.
 * PATCH /api/me/trading { enabled?, maxTradeEth?, acceptFeeRedirects?, replyLanguage? } → update them.
 *
 * Trading from a post is off for every account until the user turns it on
 * here. The cap is theirs to set, bounded by the deployment's MAX_TRADE_ETH;
 * an empty cap means the deployment default. The bot reads these on every
 * trade command, and Privy's policy bounds the value again in the enclave.
 */

type Settings = { enabled: boolean; maxTradeEth: string | null; defaultCapEth: string; maxCapEth: string; acceptFeeRedirects: boolean; replyLanguage: "auto" | "en" };

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

function limits() {
  const e = env();
  return { maxCapWei: parseEther(e.MAX_TRADE_ETH), defaultCapEth: e.DEFAULT_USER_TRADE_CAP_ETH, maxCapEth: e.MAX_TRADE_ETH };
}

async function current(xUserId: string): Promise<Settings> {
  const { defaultCapEth, maxCapEth } = limits();
  const row = await db().user.findUnique({ where: { xUserId }, select: { tradingEnabled: true, maxTradeWei: true, acceptFeeRedirects: true, replyLanguage: true } });
  return {
    enabled: row?.tradingEnabled ?? false,
    maxTradeEth: row?.maxTradeWei ? formatEther(BigInt(row.maxTradeWei)) : null,
    defaultCapEth,
    maxCapEth,
    acceptFeeRedirects: row?.acceptFeeRedirects ?? true,
    replyLanguage: row?.replyLanguage === "en" ? "en" : "auto",
  };
}

export async function GET(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);
  return Response.json(await current(user.xUserId));
}

export async function PATCH(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);
  if (!user.hasLoggedIn || !user.wallet) return bad("sign in and create a wallet first", 409);

  let body: { enabled?: unknown; maxTradeEth?: unknown; acceptFeeRedirects?: unknown; replyLanguage?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("body must be JSON");
  }
  const data: { tradingEnabled?: boolean; maxTradeWei?: string | null; acceptFeeRedirects?: boolean; replyLanguage?: string } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad("enabled must be true or false");
    data.tradingEnabled = body.enabled;
  }
  if (body.acceptFeeRedirects !== undefined) {
    if (typeof body.acceptFeeRedirects !== "boolean") return bad("acceptFeeRedirects must be true or false");
    data.acceptFeeRedirects = body.acceptFeeRedirects;
  }
  if (body.replyLanguage !== undefined) {
    if (body.replyLanguage !== "auto" && body.replyLanguage !== "en") return bad("replyLanguage must be auto or en");
    data.replyLanguage = body.replyLanguage;
  }
  if (body.maxTradeEth !== undefined) {
    if (body.maxTradeEth === null || body.maxTradeEth === "") data.maxTradeWei = null;
    else {
      if (typeof body.maxTradeEth !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(body.maxTradeEth.trim())) return bad("maxTradeEth must be a plain decimal number of ETH");
      const wei = parseEther(body.maxTradeEth.trim());
      const { maxCapWei, maxCapEth } = limits();
      if (wei <= 0n) return bad("the cap must be above zero");
      if (wei > maxCapWei) return bad(`the cap cannot exceed ${maxCapEth} ETH`);
      data.maxTradeWei = wei.toString();
    }
  }
  if (Object.keys(data).length === 0) return bad("nothing to change");

  try {
    await db().user.upsert({
      where: { xUserId: user.xUserId },
      create: {
        xUserId: user.xUserId,
        xHandle: user.xHandle ?? "",
        xName: user.xName,
        xAvatarUrl: user.xAvatarUrl,
        privyUserId: user.privyUserId,
        walletAddress: user.wallet.address,
        walletId: user.wallet.walletId,
        delegated: user.wallet.delegated,
        linkedAt: new Date(),
        ...data,
      },
      update: data,
    });
  } catch (err) {
    logger.error({ err, xUserId: user.xUserId }, "trading settings update failed");
    return bad("could not save", 500);
  }
  logger.info({ xUserId: user.xUserId, ...data }, "trading settings changed");
  return Response.json(await current(user.xUserId));
}
