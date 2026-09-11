import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME } from "@/components/links";
import { EXT_ICON, TokenLogo } from "@/components/TokenLogo";
import { CHAIN_SHORT, chainKeyOf } from "@/lib/chains-web";
import { timeAgo } from "@/lib/ipfs";
import { listLiveSites, SITES_ROOT_DOMAIN } from "@/lib/sites";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Sites — ${SITE_NAME}`,
  description: `Websites the agent built for tokens launched through ${SITE_NAME}, live on ${SITES_ROOT_DOMAIN}.`,
};

/**
 * The gallery: every token site that is live, newest first. Each card frames
 * the real site, scaled down and sandboxed (no scripts, no navigation), so
 * what is shown is exactly what visitors get.
 */
export default async function SitesPage() {
  const sites = await listLiveSites().catch(() => []);
  return (
    <main className="wrap sites-page">
      <header className="sites-head">
        <h1 className="grad">Sites built by the agent</h1>
        <p>
          Add <em>site</em> to a launch, from a post or from the form, and the agent writes a one-page website for the token at <em>name.{SITES_ROOT_DOMAIN}</em>: the story, how to buy, live
          price and holders. Creators keep editing it in plain words. Beta.
        </p>
        <div className="sites-cta">
          <Link className="btn-p" href="/launch">
            Launch with a site
          </Link>
          <Link className="btn-s" href="/how-it-works">
            How it works
          </Link>
        </div>
      </header>

      {sites.length === 0 ? (
        <div className="sites-empty">No site is live yet. The first one built from a launch shows up here.</div>
      ) : (
        <div className="sites-grid">
          {sites.map((s) => (
            <article className="site-card" key={s.slug}>
              <a className="site-shot" href={s.url} target="_blank" rel="noreferrer" aria-label={`Open the site of ${s.name}`}>
                <iframe src={s.url} title={`${s.name} site`} loading="lazy" sandbox="" tabIndex={-1} />
              </a>
              <div className="site-meta">
                <TokenLogo symbol={s.ticker} imageUrl={s.logoUrl} className="site-logo" />
                <div className="site-name">
                  <b>
                    {s.name} <em>${s.ticker}</em>
                  </b>
                  <span>
                    {s.slug}.{SITES_ROOT_DOMAIN} · {CHAIN_SHORT[chainKeyOf(s.chainId)]}
                    {s.creatorHandle ? ` · by @${s.creatorHandle}` : ""} · {timeAgo(s.publishedAt)}
                  </span>
                </div>
                <div className="site-actions">
                  {s.token && (
                    <Link className="btn-s" href={`/token/${s.token}`}>
                      Token
                    </Link>
                  )}
                  <a className="btn-s" href={s.url} target="_blank" rel="noreferrer">
                    Open {EXT_ICON}
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
