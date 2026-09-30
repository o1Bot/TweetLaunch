/**
 * Who Lighter will not serve.
 *
 * Taken verbatim from https://lighter.xyz/terms, fetched 2026-09-20:
 *
 *   "OUR SERVICES WERE NOT DEVELOPED FOR, AND ARE NOT AVAILABLE TO PERSONS OR
 *    ENTITIES WHO RESIDE IN, ARE LOCATED IN, ARE INCORPORATED IN, OR HAVE A
 *    REGISTERED OFFICE OR PRINCIPAL PLACE OF BUSINESS IN THE UNITED STATES OF
 *    AMERICA, CANADA, THE UNITED KINGDOM, CHINA, NORTH KOREA, RUSSIA, UKRAINE,
 *    CUBA, IRAN, VENEZUELA, SUDAN, BELARUS, MYANMAR OR SYRIA."
 *
 * The same terms separately disclaim any jurisdiction under comprehensive
 * country-wide or regional sanctions, which this list cannot enumerate. An IP
 * lookup is a first filter, not a compliance programme: the attestation at
 * opt-in is what the user is actually held to, and the venue enforces its own
 * terms regardless of what this app allows.
 *
 * Lives in the package because two apps hold people to it: the terminal at its
 * gate, and the web API when someone opts in to trading from a post.
 *
 * RESTRICTED_COUNTRIES_EXTRA adds codes without a deploy if the venue's terms
 * change before this file does.
 */
export const RESTRICTED_COUNTRIES = [
  "US", // United States of America
  "CA", // Canada
  "GB", // United Kingdom
  "CN", // China
  "KP", // North Korea
  "RU", // Russia
  "UA", // Ukraine
  "CU", // Cuba
  "IR", // Iran
  "VE", // Venezuela
  "SD", // Sudan
  "BY", // Belarus
  "MM", // Myanmar
  "SY", // Syria
] as const;

export const TERMS_URL = "https://lighter.xyz/terms";
export const TERMS_FETCHED_AT = "2026-09-20";

declare const process: { env: Record<string, string | undefined> } | undefined;

function extra(): string[] {
  const raw = typeof process !== "undefined" ? (process.env.RESTRICTED_COUNTRIES_EXTRA ?? "") : "";
  return raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

export type Eligibility =
  | { status: "allowed"; country: string }
  | { status: "restricted"; country: string }
  | { status: "unknown" };

/**
 * `country` is an ISO 3166-1 alpha-2 code, or null when nothing identified the
 * request. Unknown is NOT treated as allowed: the caller decides, and the
 * opt-in page makes the user state their jurisdiction instead of assuming one.
 */
export function eligibility(country: string | null | undefined): Eligibility {
  const code = country?.trim().toUpperCase();
  if (!code || code.length !== 2 || code === "XX") return { status: "unknown" };
  const blocked = new Set<string>([...RESTRICTED_COUNTRIES, ...extra()]);
  return blocked.has(code) ? { status: "restricted", country: code } : { status: "allowed", country: code };
}

const NAMES: Record<string, string> = {
  US: "the United States",
  CA: "Canada",
  GB: "the United Kingdom",
  CN: "China",
  KP: "North Korea",
  RU: "Russia",
  UA: "Ukraine",
  CU: "Cuba",
  IR: "Iran",
  VE: "Venezuela",
  SD: "Sudan",
  BY: "Belarus",
  MM: "Myanmar",
  SY: "Syria",
};

export function countryName(code: string): string {
  return NAMES[code.toUpperCase()] ?? code.toUpperCase();
}
