import { getAddress, isAddress, isHex } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { normalizeHandle } from "@o1bot/shared";
import { userFromRequest } from "@o1bot/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Transfers made from the profile.
 *
 *   POST /api/me/send   records one the browser just signed
 *   GET  /api/me/send   the user's sent and received transfers, newest first
 *
 * The chain is the source of truth for whether a transfer went through; this
 * is the history with names on it, so a recipient who logs in later sees
 * who sent them what.
 */

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });
const CHAIN_IDS = new Set([4663, 8453, 5042]);

type Body = { chainId?: unknown; token?: unknown; symbol?: unknown; decimals?: unknown; amount?: unknown; to?: unknown; toHandle?: unknown; toXUserId?: unknown; txHash?: unknown };

export async function POST(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("unauthenticated", 401);
  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return bad("bad json");
  }
  const chainId = Number(b.chainId);
  const token = String(b.token ?? "");
  const symbol = String(b.symbol ?? "").slice(0, 32);
  const decimals = Number(b.decimals);
  const amount = String(b.amount ?? "").trim();
  const to = String(b.to ?? "");
  const txHash = String(b.txHash ?? "");
  if (!CHAIN_IDS.has(chainId)) return bad("unknown chain");
  if (token !== "native" && !isAddress(token, { strict: false })) return bad("bad token");
  if (!symbol) return bad("missing symbol");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return bad("bad decimals");
  if (!/^\d+(\.\d+)?$/.test(amount)) return bad("bad amount");
  if (!isAddress(to, { strict: false })) return bad("bad recipient");
  if (!isHex(txHash) || txHash.length !== 66) return bad("bad transaction hash");
  const toHandle = b.toHandle ? normalizeHandle(String(b.toHandle)) : null;
  const toXUserId = b.toXUserId ? String(b.toXUserId).slice(0, 40) : null;
  const toUser = toXUserId ? await db().user.findUnique({ where: { xUserId: toXUserId }, select: { xUserId: true } }) : null;

  const row = await db().transfer.upsert({
    where: { txHash },
    create: { fromXUserId: me.xUserId, toXUserId: toUser?.xUserId ?? null, toHandle, toAddress: getAddress(to.toLowerCase()), chainId, token: token === "native" ? "native" : getAddress(token.toLowerCase()), symbol, decimals, amount, txHash },
    update: {},
  });
  return Response.json({ id: row.id });
}

export async function GET(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("unauthenticated", 401);
  const person = { select: { xHandle: true, xName: true, xAvatarUrl: true } };
  const [sent, received] = await Promise.all([
    db().transfer.findMany({ where: { fromXUserId: me.xUserId }, orderBy: { createdAt: "desc" }, take: 50, include: { to: person } }),
    db().transfer.findMany({ where: { toXUserId: me.xUserId }, orderBy: { createdAt: "desc" }, take: 50, include: { from: person } }),
  ]);
  const shape = (t: (typeof sent)[number] | (typeof received)[number], who: { xHandle: string; xName: string | null; xAvatarUrl: string | null } | null, direction: "sent" | "received") => ({
    id: t.id,
    direction,
    chainId: t.chainId,
    token: t.token,
    symbol: t.symbol,
    decimals: t.decimals,
    amount: t.amount,
    address: direction === "sent" ? t.toAddress : null,
    handle: who?.xHandle ?? t.toHandle ?? null,
    name: who?.xName ?? null,
    avatarUrl: who?.xAvatarUrl ?? null,
    txHash: t.txHash,
    createdAt: t.createdAt.toISOString(),
  });
  return Response.json({
    sent: sent.map((t) => shape(t, t.to, "sent")),
    received: received.map((t) => shape(t, t.from, "received")),
  });
}
