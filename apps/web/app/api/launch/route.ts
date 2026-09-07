import { parseEther } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { checkImageBytes, IMAGE_MAX_BYTES } from "@o1bot/executor";

/** Vercel functions accept bodies up to 4.5 MB; the browser shrinks logos well below this first. */
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
import { parseDecimalToRaw } from "@o1bot/market";
import { cleanDescription, cleanTelegram, cleanWebsite, cleanXHandle, NAME_MAX, TICKER_RE } from "@o1bot/parser";
import { activeFactory, env, findQuote, isReservedHandle, logger, normalizeHandle, RESERVED_HANDLES, tickerCollidesWithStock } from "@o1bot/shared";
import { linkStatus, userFromRequest } from "@o1bot/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/launch — record a launch request from the web form. The bot
 * worker on the server side picks it up, runs the same checks and the same
 * signing path as a post on X, and writes the outcome back to the row;
 * the page polls GET /api/launch/:id until then. Nothing is signed here.
 */

/** Launch statuses that count against the per-account limits, plus in-flight web launches. */
const COUNTED = ["QUEUED", "SIMULATING", "DRY_RUN", "SIGNING", "BROADCAST", "CONFIRMED", "FEE_RECIPIENT_PENDING", "REPLIED"] as const;

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

const text = (form: FormData, key: string): string | null => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

export async function POST(req: Request) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const user = await userFromRequest(req);
  if (!user) return bad("unauthenticated", 401);
  const status = linkStatus(user);
  if (!status.linked) return bad(`link your account first (${status.reason})`, 403);
  if (!user.xHandle) return bad("this account has no X handle", 403);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("expected multipart form data");
  }
  const e = env();

  const ticker = (text(form, "ticker") ?? "").replace(/^\$/, "").toUpperCase();
  if (!TICKER_RE.test(ticker)) return bad("ticker must be 1 to 11 letters or digits");
  if (tickerCollidesWithStock("robinhood", ticker)) return bad(`$${ticker} is a stock token symbol on o1 and cannot be a new ticker`);
  const name = text(form, "name") ?? "";
  if (!name || [...name].length > NAME_MAX) return bad(`name must be 1 to ${NAME_MAX} characters`);
  const pairInput = text(form, "pair") ?? "";
  const quote = findQuote("robinhood", pairInput);
  if (!quote) return bad(`${pairInput || "pair"} is not a registered pair`);

  const devBuyNative = text(form, "devBuyNative");
  let devBuyWei: bigint | null = null;
  if (devBuyNative) {
    try {
      devBuyWei = parseDecimalToRaw(devBuyNative, 18);
    } catch {
      return bad("dev buy must be a plain ETH amount, for example 0.05");
    }
    if (devBuyWei <= 0n) return bad("dev buy must be above zero");
    if (devBuyWei > parseEther(e.MAX_DEV_BUY_ETH)) return bad(`dev buy is capped at ${e.MAX_DEV_BUY_ETH} ETH`);
  }

  const description = cleanDescription(text(form, "description"));
  const websiteRaw = text(form, "website");
  const website = cleanWebsite(websiteRaw);
  if (websiteRaw && !website) return bad("website must be an http(s) URL");
  const telegramRaw = text(form, "telegram");
  const telegram = cleanTelegram(telegramRaw);
  if (telegramRaw && !telegram) return bad("telegram must be a t.me link or a handle");
  const xRaw = text(form, "xHandle");
  const xHandle = cleanXHandle(xRaw);
  if (xRaw && !xHandle) return bad("x must be a handle or an x.com profile link");

  const feesRaw = text(form, "feesToHandle");
  let feesToHandle: string | null = null;
  if (feesRaw) {
    feesToHandle = normalizeHandle(feesRaw);
    if (!feesToHandle) return bad("fees-to must be an X handle");
    if (isReservedHandle(feesToHandle, [...RESERVED_HANDLES, e.X_BOT_HANDLE])) return bad(`@${feesToHandle} cannot receive creator fees`);
    if (feesToHandle === user.xHandle.toLowerCase()) feesToHandle = null;
  }

  let imageData: Uint8Array | null = null;
  let imageMime: string | null = null;
  const image = form.get("image");
  if (image instanceof File && image.size > 0) {
    // The browser downscales large images before upload; this cap is the request-size safety net.
    if (image.size > UPLOAD_MAX_BYTES) return bad("image is too large even after compression; use a file under 4 MB");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const checked = checkImageBytes(bytes);
    if (!checked.ok) return bad(`image rejected (${checked.reason.replace(/_/g, " ")}): PNG, JPEG, WebP or GIF`);
    if (checked.image.mime === "image/gif" && bytes.length > IMAGE_MAX_BYTES) return bad("animated GIFs cannot be shrunk; use a GIF under 2 MB or a still image");
    imageData = checked.image.bytes;
    imageMime = checked.image.mime;
  }

  // Same limits the worker enforces, checked early so the user hears it now.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const [launchesToday, last] = await Promise.all([
    db().launch.count({ where: { creator: { xUserId: user.xUserId }, status: { in: [...COUNTED] }, createdAt: { gte: since } } }),
    db().launch.findFirst({ where: { creator: { xUserId: user.xUserId }, status: { in: [...COUNTED] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true, status: true } }),
  ]);
  if (launchesToday >= e.MAX_LAUNCHES_PER_USER_PER_DAY) return bad("this account has reached today's launch limit", 429);
  if (last && (last.status === "QUEUED" || last.status === "SIMULATING")) return bad("a launch from this account is already in progress", 429);
  if (last && Date.now() - last.createdAt.getTime() < e.LAUNCH_COOLDOWN_SECONDS * 1000) {
    const wait = Math.ceil((e.LAUNCH_COOLDOWN_SECONDS * 1000 - (Date.now() - last.createdAt.getTime())) / 60_000);
    return bad(`one launch per account every ${Math.round(e.LAUNCH_COOLDOWN_SECONDS / 60)} minutes; try again in ${Math.max(1, wait)} min`, 429);
  }

  const creator = await db().user.upsert({
    where: { xUserId: user.xUserId },
    create: {
      xUserId: user.xUserId,
      xHandle: user.xHandle,
      xName: user.xName,
      xAvatarUrl: user.xAvatarUrl,
      privyUserId: user.privyUserId,
      walletAddress: status.wallet.address,
      walletId: status.wallet.walletId,
      delegated: true,
      linkedAt: new Date(),
    },
    update: { xHandle: user.xHandle, xName: user.xName, xAvatarUrl: user.xAvatarUrl, privyUserId: user.privyUserId, walletAddress: status.wallet.address, walletId: status.wallet.walletId, delegated: true },
    select: { id: true },
  });

  const launch = await db().launch.create({
    data: {
      source: "WEB",
      mentionId: null,
      creatorId: creator.id,
      chainId: 4663,
      factory: activeFactory("robinhood"),
      quoteAddress: quote.address,
      quoteSymbol: quote.symbol,
      ticker,
      name,
      devBuyWei: devBuyWei === null ? null : devBuyWei.toString(),
      status: "QUEUED",
      request: { devBuyNative, description, website, telegram, xHandle, feesToHandle },
      imageData: imageData ? Buffer.from(imageData) : null,
      imageMime,
    },
    select: { id: true },
  });
  logger.info({ launchId: launch.id, xUserId: user.xUserId, ticker, pair: quote.symbol, devBuy: devBuyNative }, "web launch queued");
  return Response.json({ id: launch.id });
}
