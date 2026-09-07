import { PrivyClient } from "@privy-io/server-auth";
import { requireEnv } from "@o1bot/shared";

let cached: PrivyClient | null = null;

/** Server-side Privy client. Same app as the web front end (PRIVY_APP_ID). */
export function privy(): PrivyClient {
  if (!cached) cached = new PrivyClient(requireEnv("PRIVY_APP_ID"), requireEnv("PRIVY_APP_SECRET"));
  return cached;
}

export function privyConfigured(): boolean {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}
