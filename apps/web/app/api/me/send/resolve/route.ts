import { getAddress, isAddress } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { env, isReservedHandle, logger, normalizeHandle, RESERVED_HANDLES } from "@o1bot/shared";
import { ensureWalletForXUser, userFromRequest } from "@o1bot/wallet";
import { HttpXClient } from "@o1bot/x";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/me/send/resolve  { to: "@handle" | "0x…" }
 *
 * Turns what the user typed into the address a transfer goes to. A handle
 * resolves to that account's o1bot wallet: the wallet they log in to, or,
 * for an account that has never been here, a pregenerated Privy wallet
 * keyed by their X user id, exactly as `fees to @b` does. When they later
 * log in with X, Privy hands them that wallet and what it holds.
 */

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

export type Resolved =
  | { kind: "address"; address: string }
  | { kind: "handle"; handle: string; xUserId: string | null; name: string | null; avatarUrl: string | null; address: string; status: "self" | "linked" | "pregenerated" };

export async function POST(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("unauthenticated", 401);
  if (!me.wallet) return bad("no wallet yet", 409);
  let body: { to?: unknown };
  try {
    body = (await req.json()) as { to?: unknown };
  } catch {
    return bad("bad json");
  }
  const raw = String(body.to ?? "").trim();
  if (!raw) return bad("say who: an X handle or an address");

  if (isAddress(raw, { strict: false })) return Response.json({ kind: "address", address: getAddress(raw.toLowerCase()) } satisfies Resolved);

  const handle = normalizeHandle(raw);
  if (!handle) return bad("that is not an X handle or an address");
  if (isReservedHandle(handle, [...RESERVED_HANDLES, env().X_BOT_HANDLE ?? ""])) return bad(`@${handle} cannot receive here`);
  if (me.xHandle && handle === normalizeHandle(me.xHandle)) {
    return Response.json({ kind: "handle", handle, xUserId: me.xUserId, name: me.xName, avatarUrl: me.xAvatarUrl, address: me.wallet.address, status: "self" } satisfies Resolved);
  }

  // Someone who has been here: the wallet they log in to, or one made for them before.
  const known = await db().user.findFirst({ where: { xHandle: { equals: handle, mode: "insensitive" } }, orderBy: { updatedAt: "desc" } });
  if (known?.walletAddress) {
    return Response.json({ kind: "handle", handle: known.xHandle, xUserId: known.xUserId, name: known.xName, avatarUrl: known.xAvatarUrl, address: known.walletAddress, status: known.linkedAt ? "linked" : "pregenerated" } satisfies Resolved);
  }

  // Never here: find the account on X and make a wallet for it.
  let x: HttpXClient;
  try {
    x = new HttpXClient();
  } catch {
    return bad("handle lookups are not configured on this server; send to an address instead", 503);
  }
  const found = await x.lookupUser(handle).catch(() => ({ found: false as const, reason: "unavailable" as const }));
  if (!found.found) {
    if (found.reason === "not_found") return bad(`@${handle} does not exist on X`, 404);
    if (found.reason === "suspended") return bad(`@${handle} is suspended on X`);
    return bad("X did not answer; try again in a moment", 503);
  }
  const linked = await ensureWalletForXUser({ xUserId: found.user.id, username: found.user.username, name: found.user.name, avatarUrl: found.user.profileImageUrl });
  if (!linked.wallet) return bad("could not create a wallet for that account", 502);
  const wallet = getAddress(linked.wallet.address);
  await db().user.upsert({
    where: { xUserId: found.user.id },
    create: { xUserId: found.user.id, xHandle: found.user.username.toLowerCase(), xName: found.user.name, xAvatarUrl: found.user.profileImageUrl, privyUserId: linked.privyUserId, walletAddress: wallet, walletId: linked.wallet.walletId ?? null, pregenerated: !linked.hasLoggedIn },
    update: { xHandle: found.user.username.toLowerCase(), xName: found.user.name, xAvatarUrl: found.user.profileImageUrl, privyUserId: linked.privyUserId, walletAddress: wallet, walletId: linked.wallet.walletId ?? null },
  });
  logger.info({ from: me.xHandle, to: found.user.username, wallet, pregenerated: !linked.hasLoggedIn }, "send: recipient resolved");
  return Response.json({ kind: "handle", handle: found.user.username, xUserId: found.user.id, name: found.user.name, avatarUrl: found.user.profileImageUrl, address: wallet, status: linked.hasLoggedIn ? "linked" : "pregenerated" } satisfies Resolved);
}
