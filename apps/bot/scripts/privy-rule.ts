/**
 * Add the Lighter key-registration rule to the EXISTING signer policy, in place.
 *
 * privy-policy.ts creates a policy. Replacing one changes PRIVY_POLICY_ID and
 * every user has to grant the signer again on their next visit — and users who
 * never visit again lose launches from a post until they do. A policy's rules
 * can be added one at a time instead, in a request signed by the policy's
 * owner key, which is what this does. Nothing else changes: same policy id,
 * same grants.
 *
 *   pnpm privy:rule --owner-key /path/to/privy-policy-owner.key
 *   pnpm privy:rule --dry-run                       # print the rule, sign nothing
 *
 * The owner key is the file privy-policy.ts wrote (notes/privy-policy-owner.key,
 * moved offline). It is read once, used for one signature, and never stored.
 */
import "@o1bot/shared/load-env";
import { readFileSync } from "node:fs";
import { generateAuthorizationSignature } from "@privy-io/server-auth/wallet-api";
import { requireEnv } from "@o1bot/shared";
import { lighterRegistrationRule } from "./privy-rules";

const API = "https://api.privy.io/v1";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const rule = lighterRegistrationRule();
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify(rule, null, 2));
    console.log("dry run: nothing signed, nothing sent");
    return;
  }

  const policyId = requireEnv("PRIVY_POLICY_ID");
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");

  const keyPath = argValue("--owner-key");
  if (!keyPath) throw new Error("--owner-key <path> is required: the file privy-policy.ts wrote, kept offline");
  const ownerKey = readFileSync(keyPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("wallet-auth:"));
  if (!ownerKey) throw new Error("the owner key file has no wallet-auth: line");

  const url = `${API}/policies/${policyId}/rules`;
  // Privy canonicalises the body on both sides, so the signature covers the
  // rule as an object, not this particular serialisation of it.
  const signature = generateAuthorizationSignature({
    input: { version: 1, method: "POST", url, body: rule, headers: { "privy-app-id": appId } },
    authorizationPrivateKey: ownerKey,
  });
  if (!signature) throw new Error("could not sign the request with the owner key");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "privy-app-id": appId,
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
      "content-type": "application/json",
      "privy-authorization-signature": signature,
    },
    body: JSON.stringify(rule),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Privy policies/${policyId}/rules: HTTP ${res.status} ${text.slice(0, 400)}`);
  const created = JSON.parse(text) as { id?: string };
  console.log(`rule added to policy ${policyId}: ${created.id ?? "(no id returned)"} — ${rule.name}`);
  console.log("policy id unchanged: no env change, no re-grant; restart the bot so its worker can rely on it");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
