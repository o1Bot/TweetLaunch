import { db, dbConfigured, Prisma } from "@o1bot/db";
import { logger } from "@o1bot/shared";
import { checkSlug, slugFromTicker } from "@o1bot/sites";
import { userFromRequest } from "@o1bot/wallet";
import { SITES_ROOT_DOMAIN, siteUrlFor } from "@/lib/site-domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Launch statuses that mean the token exists on chain. */
const LIVE = new Set(["CONFIRMED", "FEE_RECIPIENT_PENDING", "REPLIED"]);

const bad = (error: string, status: number, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status });

/**
 * POST /api/site — build a website for one of the caller's own live tokens,
 * the web counterpart of posting "build a site for $TICKER". Body:
 * { launchId: string, slug?: string }. Reserves the subdomain and queues the
 * first build; the bot worker runs it and the editor page shows progress.
 * Answers 409 when the launch already has a site or the name is taken.
 */
export async function POST(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);

  let body: { launchId?: unknown; slug?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("invalid body", 400);
  }
  const launchId = typeof body.launchId === "string" ? body.launchId : "";
  if (!launchId) return bad("launchId required", 400);
  const slugRaw = typeof body.slug === "string" ? body.slug.trim() : "";

  const launch = await db().launch.findFirst({
    where: { id: launchId, creator: { xUserId: user.xUserId } },
    select: { id: true, ticker: true, chainId: true, tokenAddress: true, status: true, creatorId: true, site: { select: { id: true, slug: true, status: true } } },
  });
  if (!launch) return bad("not found", 404);
  if (!launch.tokenAddress || !LIVE.has(launch.status)) return bad("the token is not live yet", 400);

  const existing = launch.site;
  if (existing && existing.status === "SUSPENDED") return bad("this site is suspended", 403);
  const view = (slug: string) => ({ slug, url: siteUrlFor(slug), editUrl: `/site/${slug}` });
  if (existing && existing.status !== "FAILED") return bad("this token already has a site", 409, view(existing.slug));

  // A failed first build is built again under its own name; anything else gets a fresh reservation.
  if (existing) {
    const active = await db().tokenSiteJob.count({ where: { siteId: existing.id, status: { in: ["QUEUED", "RUNNING"] } } });
    if (active > 0) return bad("a build is already running", 409, view(existing.slug));
    await db().$transaction([
      db().tokenSite.update({ where: { id: existing.id }, data: { status: "GENERATING", error: null, token: launch.tokenAddress } }),
      db().tokenSiteJob.create({ data: { siteId: existing.id, instruction: null, baseN: null, createdById: launch.creatorId } }),
    ]);
    logger.info({ launchId, slug: existing.slug }, "site build queued again from the web");
    return Response.json(view(existing.slug), { status: 202 });
  }

  const check = slugRaw ? checkSlug(slugRaw) : slugFromTicker(launch.ticker);
  if (!check.ok) return bad(check.reason === "reserved" ? `${check.slug} is reserved; pick another name` : "a site name is 3 to 32 lowercase letters, digits and dashes", 400);
  try {
    const site = await db().tokenSite.create({
      data: { slug: check.slug, chainId: launch.chainId, token: launch.tokenAddress, launchId: launch.id, ownerId: launch.creatorId, status: "GENERATING" },
      select: { id: true },
    });
    await db().tokenSiteJob.create({ data: { siteId: site.id, instruction: null, baseN: null, createdById: launch.creatorId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return bad(`${check.slug}.${SITES_ROOT_DOMAIN} is taken; pick another name`, 409);
    throw err;
  }
  logger.info({ launchId, slug: check.slug, xUserId: user.xUserId }, "site build queued from the web");
  return Response.json(view(check.slug), { status: 202 });
}
