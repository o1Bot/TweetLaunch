/**
 * Operator kill switch for a token site.
 *
 *   pnpm site:suspend <slug>            take the site down: its address shows a notice, the editor is closed
 *   pnpm site:suspend <slug> --restore  put it back as it was (published version served again)
 *
 * Nothing is deleted; versions and jobs stay for review.
 */
import "@o1bot/shared/load-env";
import { db, disconnectDb } from "@o1bot/db";

const [slug, flag] = process.argv.slice(2);
if (!slug) {
  console.error("usage: pnpm site:suspend <slug> [--restore]");
  process.exit(2);
}
const site = await db().tokenSite.findUnique({ where: { slug }, select: { id: true, status: true, publishedN: true } });
if (!site) {
  console.error(`no site with slug ${slug}`);
  process.exit(1);
}
if (flag === "--restore") {
  const status = site.publishedN !== null ? "LIVE" : "FAILED";
  await db().tokenSite.update({ where: { id: site.id }, data: { status, error: null } });
  console.log(`${slug}: ${site.status} -> ${status}`);
} else {
  await db().tokenSite.update({ where: { id: site.id }, data: { status: "SUSPENDED", error: "suspended by the operator" } });
  await db().tokenSiteJob.updateMany({ where: { siteId: site.id, status: "QUEUED" }, data: { status: "FAILED", error: "site suspended", finishedAt: new Date() } });
  console.log(`${slug}: ${site.status} -> SUSPENDED (the CDN serves the notice within a minute)`);
}
await disconnectDb();
