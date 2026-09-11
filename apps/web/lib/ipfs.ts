/**
 * Gateways tried in order for `ipfs://` content. The configured one comes
 * first (o1bot's dedicated Pinata gateway in production, which only serves
 * pins in o1bot's account), then o1's gateway for documents o1 pinned at
 * launch, then Pinata's public gateway. ipfs.io and dweb.link stopped
 * serving plain HTTP requests in 2026, so they are not on the list.
 */
export const PUBLIC_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
export const O1_GATEWAY = "https://sapphire-negative-junglefowl-959.mypinata.cloud/ipfs/";

const trim = (g: string) => g.replace(/\/$/, "");
const GATEWAY = trim(process.env.IPFS_GATEWAY ?? PUBLIC_GATEWAY);
const GATEWAYS = Array.from(new Set([GATEWAY, trim(O1_GATEWAY), trim(PUBLIC_GATEWAY)]));

/** `ipfs://CID` → URL on the primary gateway; anything else is returned unchanged. */
export function ipfsToHttp(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return `${GATEWAY}/${uri.slice("ipfs://".length)}`;
  return uri;
}

/** Every gateway URL worth trying for a URI, primary first; a plain URL is returned alone. */
export function ipfsCandidates(uri: string | null | undefined): string[] {
  if (!uri) return [];
  const path = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri.match(/\/ipfs\/(.+)$/)?.[1];
  if (!path) return [uri];
  return GATEWAYS.map((g) => `${g}/${path}`);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function timeAgo(iso: string | Date): string {
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Stable tile colour from a symbol, for tokens without an image. */
export function symbolColor(symbol: string): string {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 46%)`;
}

/**
 * `ipfs://CID` on the public gateway, for pages served on other origins
 * (token sites on their subdomains) and for link previews fetched by X and
 * others: the dedicated gateway is metered and can refuse, the public one
 * answers anyone. A plain URL is returned unchanged.
 */
export function publicIpfsUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const path = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri.match(/\/ipfs\/(.+)$/)?.[1];
  return path ? `${trim(PUBLIC_GATEWAY)}/${path}` : uri;
}
