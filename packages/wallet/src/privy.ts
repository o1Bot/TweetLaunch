import { PrivyClient } from "@privy-io/server-auth";
import { requireEnv } from "@o1bot/shared";

let cached: PrivyClient | null = null;

/**
 * Server-side Privy client. Same app as the web front end (PRIVY_APP_ID).
 * Wallets live in Privy's TEE, so signing from a user's wallet requires the
 * app's authorization key: users add its key quorum as a signer on their
 * wallet (onboarding), and every wallet API request is signed with the
 * matching private key here.
 */
export function privy(): PrivyClient {
  if (!cached) {
    const authorizationPrivateKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim();
    cached = new PrivyClient(requireEnv("PRIVY_APP_ID"), requireEnv("PRIVY_APP_SECRET"), authorizationPrivateKey ? { walletApi: { authorizationPrivateKey } } : undefined);
  }
  return cached;
}

export function privyConfigured(): boolean {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

/** The key quorum id users grant as a signer; without it the bot cannot tell whether it may sign. */
export function privySignerId(): string | null {
  return process.env.PRIVY_SIGNER_ID?.trim() || null;
}

/** True when the server holds the key that matches the signer users grant. */
export function privySigningConfigured(): boolean {
  return Boolean(privySignerId() && process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim());
}
