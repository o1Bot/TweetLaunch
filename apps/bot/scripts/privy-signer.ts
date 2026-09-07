/**
 * Create the bot's Privy signer without the dashboard: generate a P-256 key
 * pair locally, register its public key as a 1-of-1 key quorum through the
 * Privy API, and write the three resulting variables into the root .env
 * (PRIVY_SIGNER_ID, NEXT_PUBLIC_PRIVY_SIGNER_ID, PRIVY_AUTHORIZATION_PRIVATE_KEY).
 *
 *   pnpm privy:signer            # refuses to overwrite values that are already set
 *   pnpm privy:signer --force    # replace them (users must re-grant the new signer)
 *
 * The private key is written to .env only and never printed. Privy never
 * sees it either; keep a backup of .env somewhere safe.
 */
import "@o1bot/shared/load-env";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@o1bot/shared/load-env";
import { requireEnv } from "@o1bot/shared";

const VARS = ["PRIVY_SIGNER_ID", "NEXT_PUBLIC_PRIVY_SIGNER_ID", "PRIVY_AUTHORIZATION_PRIVATE_KEY"] as const;

async function main() {
  const force = process.argv.includes("--force");
  const root = findRepoRoot();
  if (!root) throw new Error("repository root not found");
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) throw new Error(".env not found at the repository root");
  const current = readFileSync(envPath, "utf8");
  const already = VARS.filter((k) => new RegExp(`^${k}=.+$`, "m").test(current));
  if (already.length && !force) {
    throw new Error(`${already.join(", ")} already set in .env; pass --force to replace them (existing users will have to re-grant the signer)`);
  }

  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");

  // P-256 (prime256v1) is what Privy's authorization keys use.
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  const res = await fetch("https://api.privy.io/v1/key_quorums", {
    method: "POST",
    headers: {
      "privy-app-id": appId,
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ display_name: "o1bot server signer", public_keys: [publicDer], authorization_threshold: 1 }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Privy key quorum creation failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  const quorum = JSON.parse(body) as { id?: string };
  if (!quorum.id) throw new Error(`Privy returned no key quorum id: ${body.slice(0, 300)}`);

  const values: Record<(typeof VARS)[number], string> = {
    PRIVY_SIGNER_ID: quorum.id,
    NEXT_PUBLIC_PRIVY_SIGNER_ID: quorum.id,
    PRIVY_AUTHORIZATION_PRIVATE_KEY: `wallet-auth:${privateDer}`,
  };
  let next = current;
  for (const k of VARS) {
    const line = `${k}=${values[k]}`;
    next = new RegExp(`^${k}=.*$`, "m").test(next) ? next.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${next.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(envPath, next);

  console.log(`key quorum created: ${quorum.id}`);
  console.log(`written to .env: ${VARS.join(", ")} (the private key is in .env only, not shown here)`);
  console.log("next: pnpm env:split, paste deploy/bot.env into Railway and deploy/web.env into Vercel, redeploy the web app, then pnpm doctor");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
