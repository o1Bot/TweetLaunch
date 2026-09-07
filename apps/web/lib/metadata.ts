import { ipfsToHttp } from "./ipfs";

/**
 * The token's ERC-7572 metadata document, pinned by the bot at launch. It
 * carries the description and public links the creator gave in the launch
 * post, using the same keys o1's own documents use. Fetched server-side
 * with a short timeout; a missing or slow gateway just hides the block.
 */
export type TokenMetadata = {
  description: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
};

const asHttpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const url = new URL(v.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

export async function fetchTokenMetadata(metadataUri: string | null | undefined): Promise<TokenMetadata | null> {
  const url = ipfsToHttp(metadataUri);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), next: { revalidate: 600 } });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const description = typeof json.description === "string" ? json.description.trim().slice(0, 2000) : "";
    return {
      description: description || null,
      website: asHttpsUrl(json.website),
      x: asHttpsUrl(json.x),
      telegram: asHttpsUrl(json.telegram),
    };
  } catch {
    return null;
  }
}
