import { NextResponse, type NextRequest } from "next/server";
import { slugFromHost } from "@o1bot/sites/slug";

/**
 * Token sites live on subdomains of the root domain (`cat.o1bot.exchange`).
 * Any request whose host carries a site slug is rewritten to the internal
 * renderer route, marked with a header so the route cannot be reached
 * directly on the apex; the apex, www and every other host pass through
 * untouched. The wildcard domain `*.o1bot.exchange` must be attached to the
 * Vercel project for those hosts to reach this app at all.
 */

const ROOT_DOMAIN = process.env.SITES_ROOT_DOMAIN ?? "o1bot.exchange";
/** `cat.localhost:3000` works with `next dev` without any DNS setup. */
const DEV_ROOT = "localhost";
/** Set by the proxy on rewrites (the slug and the path asked for); the renderer refuses requests without them. */
export const SITE_HEADER = "x-o1bot-site";
export const SITE_PATH_HEADER = "x-o1bot-site-path";

export const config = {
  matcher: ["/((?!_next/|api/|site-render/|favicon\\.ico|icon\\.png|sitemap\\.xml).*)"],
};

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const slug = slugFromHost(host, ROOT_DOMAIN) ?? (process.env.NODE_ENV !== "production" ? slugFromHost(host, DEV_ROOT) : null);
  if (!slug) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = `/site-render/${slug}`;
  url.search = "";
  // Query strings do not survive the rewrite reliably; headers do.
  const headers = new Headers(req.headers);
  headers.set(SITE_HEADER, slug);
  headers.set(SITE_PATH_HEADER, req.nextUrl.pathname);
  return NextResponse.rewrite(url, { request: { headers } });
}
