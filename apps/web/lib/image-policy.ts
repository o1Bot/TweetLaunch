import { GATEWAY_HOSTS } from "./ipfs";

/**
 * Whether the server may fetch an image URL itself: https on one of the
 * IPFS gateways the site resolves `ipfs://` through, nothing else. A token's
 * image URI is metadata written by whoever launched it, and a server-side
 * fetch of an arbitrary URL would let a launch probe the deployment's own
 * network; such a logo simply is not inlined. Plain TypeScript so the rule
 * is testable without the image renderer's JSX.
 */
export function isAllowedImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && GATEWAY_HOSTS.includes(parsed.hostname);
}
