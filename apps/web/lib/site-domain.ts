/**
 * Where the token sites live. A separate module so both the market reads
 * and the site reads can import it without importing each other.
 */
export const SITES_ROOT_DOMAIN = process.env.SITES_ROOT_DOMAIN ?? "o1bot.app";

export const siteUrlFor = (slug: string): string => `https://${slug}.${SITES_ROOT_DOMAIN}`;
