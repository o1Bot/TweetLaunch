/** Public-facing links. NEXT_PUBLIC_* values are inlined at build time. */
export const SITE_NAME = "o1bot.exchange";
export const BOT_HANDLE = "o1bot_exchange";
export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.o1bot.exchange";
export const X_URL = process.env.NEXT_PUBLIC_X_URL ?? `https://x.com/${BOT_HANDLE}`;
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/o1bot-exchange";
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "hello@o1bot.exchange";
export const LEGAL_UPDATED = "2026-09-07";
