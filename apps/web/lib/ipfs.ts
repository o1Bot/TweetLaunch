const GATEWAY = (process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/").replace(/\/$/, "");

/** ipfs://CID → gateway URL; anything else is returned unchanged. */
export function ipfsToHttp(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return `${GATEWAY}/${uri.slice("ipfs://".length)}`;
  return uri;
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
