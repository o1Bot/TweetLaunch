import { ipfsCandidates } from "./ipfs";

/**
 * The token's ERC-7572 metadata document, pinned at launch either by o1
 * (through its Public API) or by the bot's own Pinata account. It carries
 * the description and public links the creator gave, using the same keys
 * o1's own documents use (o1 nests links under `links` in some documents).
 * Fetched server-side with a short timeout, trying each gateway in turn; a
 * missing or slow document just hides the block.
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
  for (const url of ipfsCandidates(metadataUri)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000), next: { revalidate: 600 } });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      const links = (json.links && typeof json.links === "object" ? json.links : {}) as Record<string, unknown>;
      const description = typeof json.description === "string" ? json.description.trim().slice(0, 2000) : "";
      return {
        description: description || null,
        website: asHttpsUrl(json.website) ?? asHttpsUrl(links.website),
        x: asHttpsUrl(json.x) ?? asHttpsUrl(links.twitter) ?? asHttpsUrl(links.x),
        telegram: asHttpsUrl(json.telegram) ?? asHttpsUrl(links.telegram),
      };
    } catch {
      // Try the next gateway.
    }
  }
  return null;
}
