import { db, dbConfigured } from "@o1bot/db";
import { BOT_API_KEY_INDEX, eligibility } from "@o1bot/lighter";
import { env } from "@o1bot/shared";
import { userFromRequest } from "@o1bot/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET    /api/me/perps → whether the bot may trade perps from this user's posts, and within what caps.
 * POST   /api/me/perps { maxNotionalUsd, maxLeverage, country, attest } → opt in (or update the caps).
 * DELETE /api/me/perps → opt out. The registered key stays on the account; the bot just stops using it.
 *
 * Opting in queues a key registration that the bot's worker performs (the
 * signing wasm and the vault secret live there, not here). Until it lands the
 * status reads PENDING; the terminal polls this route to show progress.
 *
 * The caller is perps.o1bot.exchange, cross-origin, with the shared Privy
 * session — proxy.ts grants that origin CORS on this path and nothing else.
 */

type Status = "none" | "PENDING" | "RUNNING" | "ACTIVE" | "FAILED" | "DISABLED";
type Blocker = "sign_in" | "no_wallet" | "not_delegated" | null;

type View = {
  status: Status;
  blocker: Blocker;
  walletAddress: string | null;
  accountIndex: string | null;
  apiKeyIndex: number;
  publicKey: string | null;
  registerTxHash: string | null;
  maxNotionalUsd: string;
  maxLeverage: number;
  attestedCountry: string | null;
  error: string | null;
  limits: { maxNotionalUsd: string; maxLeverage: number };
};

const bad = (message: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ error: message, ...extra }, { status });

function limits() {
  const e = env();
  return { maxNotionalUsd: e.PERPS_MAX_NOTIONAL_USD, maxLeverage: e.PERPS_MAX_LEVERAGE };
}

function blockerFor(user: NonNullable<Awaited<ReturnType<typeof userFromRequest>>>): Blocker {
  if (!user.hasLoggedIn) return "sign_in";
  if (!user.wallet || !user.wallet.walletId) return "no_wallet";
  if (!user.wallet.delegated || user.wallet.signerStale) return "not_delegated";
  return null;
}

async function view(xUserId: string, blocker: Blocker, walletAddress: string | null): Promise<View> {
  const row = await db().perpsAccount.findUnique({ where: { xUserId } });
  return {
    status: row?.status ?? "none",
    blocker,
    walletAddress: row?.walletAddress ?? walletAddress,
    accountIndex: row?.accountIndex?.toString() ?? null,
    apiKeyIndex: row?.apiKeyIndex ?? BOT_API_KEY_INDEX,
    publicKey: row?.publicKey ?? null,
    registerTxHash: row?.registerTxHash ?? null,
    maxNotionalUsd: row?.maxNotionalUsd ?? "100",
    maxLeverage: row?.maxLeverage ?? 5,
    attestedCountry: row?.attestedCountry ?? null,
    error: row?.error ?? null,
    limits: limits(),
  };
}

export async function GET(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);
  return Response.json(await view(user.xUserId, blockerFor(user), user.wallet?.address ?? null));
}

const NOTIONAL = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

export async function POST(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);
  const blocker = blockerFor(user);
  if (blocker) return bad("this wallet cannot be signed for by o1bot yet", 409, { blocker });
  const wallet = user.wallet!;

  let body: { maxNotionalUsd?: unknown; maxLeverage?: unknown; country?: unknown; attest?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("body must be JSON");
  }

  const cap = limits();
  if (typeof body.maxNotionalUsd !== "string" || !NOTIONAL.test(body.maxNotionalUsd.trim())) return bad("maxNotionalUsd must be a plain decimal number of USDC");
  const maxNotionalUsd = body.maxNotionalUsd.trim();
  if (Number(maxNotionalUsd) < 10) return bad("the cap must be at least 10 USDC, every market's minimum order");
  if (Number(maxNotionalUsd) > Number(cap.maxNotionalUsd)) return bad(`the cap must be at most ${cap.maxNotionalUsd} USDC on this deployment`);
  if (typeof body.maxLeverage !== "number" || !Number.isInteger(body.maxLeverage) || body.maxLeverage < 1) return bad("maxLeverage must be a whole number of at least 1");
  if (body.maxLeverage > cap.maxLeverage) return bad(`maxLeverage must be at most ${cap.maxLeverage} on this deployment`);
  const maxLeverage = body.maxLeverage;

  // The attestation is what the user is held to; the country is what the edge saw when they gave it.
  if (body.attest !== true) return bad("you must confirm you are not in a jurisdiction Lighter excludes");
  const country = typeof body.country === "string" && body.country.trim() ? body.country.trim().toUpperCase() : null;
  const check = eligibility(country);
  if (check.status === "restricted") return bad("Lighter does not serve this jurisdiction", 403);

  const existing = await db().perpsAccount.findUnique({ where: { xUserId: user.xUserId } });
  const now = new Date();
  if (!existing) {
    await db().perpsAccount.create({
      data: { xUserId: user.xUserId, walletAddress: wallet.address, apiKeyIndex: BOT_API_KEY_INDEX, maxNotionalUsd, maxLeverage, attestedCountry: country, attestedAt: now },
    });
  } else {
    const sameWallet = existing.walletAddress.toLowerCase() === wallet.address.toLowerCase();
    // A key registered for another wallet is worthless for this one: start over. A key that
    // is already on the account (ACTIVE, or DISABLED with a key) needs no new registration.
    const keyUsable = sameWallet && Boolean(existing.publicKey && existing.sealedKey) && (existing.status === "ACTIVE" || existing.status === "DISABLED");
    const status = keyUsable ? "ACTIVE" : existing.status === "RUNNING" ? "RUNNING" : "PENDING";
    await db().perpsAccount.update({
      where: { xUserId: user.xUserId },
      data: {
        walletAddress: wallet.address,
        maxNotionalUsd,
        maxLeverage,
        attestedCountry: country,
        attestedAt: now,
        status,
        disabledAt: null,
        error: status === "PENDING" ? null : existing.error,
        ...(status === "PENDING" && !sameWallet ? { accountIndex: null, publicKey: null, sealedKey: null, registerTxHash: null, attempts: 0 } : {}),
        ...(status === "PENDING" && sameWallet && existing.status === "FAILED" ? { attempts: 0 } : {}),
      },
    });
  }
  return Response.json(await view(user.xUserId, null, wallet.address));
}

export async function DELETE(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);
  const existing = await db().perpsAccount.findUnique({ where: { xUserId: user.xUserId } });
  if (existing && existing.status !== "DISABLED") {
    await db().perpsAccount.update({ where: { xUserId: user.xUserId }, data: { status: "DISABLED", disabledAt: new Date() } });
  }
  return Response.json(await view(user.xUserId, blockerFor(user), user.wallet?.address ?? null));
}
