import { NextResponse, type NextRequest } from "next/server";
import { slugFromHost } from "@o1bot/sites/slug";

/**
 * Token sites live on subdomains of a sandbox domain (`cat.o1bot.app`),
 * separate from the app so a site's scripts never share the app's origin.
 * Any request whose host carries a site slug is rewritten to the internal
 * renderer route, marked with headers so the route cannot be reached
 * directly; every other host passes through untouched. The wildcard domain
 * `*.o1bot.app` must be attached to the Vercel project for those hosts to
 * reach this app at all.
 *
 * Sites read live numbers from the token API: those responses carry CORS
 * headers for site origins (and for the editor's sandboxed preview, whose
 * origin is opaque), and for nothing else.
 */

const ROOT_DOMAIN = process.env.SITES_ROOT_DOMAIN ?? "o1bot.app";
/** `cat.localhost:3000` works with `next dev` without any DNS setup. */
const DEV_ROOT = "localhost";
/** Set by the proxy on rewrites (the slug and the path asked for); the renderer refuses requests without them. */
export const SITE_HEADER = "x-o1bot-site";
export const SITE_PATH_HEADER = "x-o1bot-site-path";

export const config = {
  matcher: ["/((?!_next/|api/|site-render/|favicon\\.ico|icon\\.png|sitemap\\.xml).*)", "/api/token/:path*"],
};

/** A site's origin, or the opaque origin of a sandboxed preview frame. */
function isSiteOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === "null") return true;
  try {
    const host = new URL(origin).host;
    return slugFromHost(host, ROOT_DOMAIN) !== null || (process.env.NODE_ENV !== "production" && slugFromHost(host, DEV_ROOT) !== null);
  } catch {
    return false;
  }
}

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/token/")) {
    const origin = req.headers.get("origin");
    if (!isSiteOrigin(origin)) return NextResponse.next();
    const headers = { "access-control-allow-origin": origin!, "access-control-allow-methods": "GET", vary: "Origin" };
    if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers });
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

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
