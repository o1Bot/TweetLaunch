import { logger, requireEnv } from "@o1bot/shared";
import { placeholderPng } from "./png";

/**
 * Token metadata: pin the image (tweet attachment or placeholder) and an
 * ERC-7572 contract-level JSON to IPFS via Pinata. o1's interface limits:
 * PNG/JPEG/WebP/GIF, ≤ 2 MB, and the declared MIME must match the bytes.
 */

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

const PINATA = "https://api.pinata.cloud/pinning";

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** Detect the image type from magic bytes, ignoring whatever the server claimed. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

export type FetchedImage = { bytes: Uint8Array; mime: ImageMime };
export type ImageRejectReason = "unreachable" | "bad_status" | "empty" | "too_large" | "mime_not_allowed" | "mime_mismatch";
export type ImageFetchResult = { ok: true; image: FetchedImage } | { ok: false; reason: ImageRejectReason };

/** Download a tweet image and enforce o1's limits. Never throws. */
export async function fetchTweetImage(url: string): Promise<ImageFetchResult> {
  // X serves the full-resolution file when name=large is requested.
  const full = url.includes("pbs.twimg.com") && !url.includes("name=") ? `${url}${url.includes("?") ? "&" : "?"}name=large` : url;
  let res: Response;
  try {
    res = await fetch(full, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!res.ok) return { ok: false, reason: "bad_status" };
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) return { ok: false, reason: "mime_not_allowed" };
  if (declared && declared !== sniffed && declared !== "image/jpg") return { ok: false, reason: "mime_mismatch" };
  return { ok: true, image: { bytes, mime: sniffed } };
}

export type PinResult = { cid: string; uri: string };

async function pinata(path: string, init: RequestInit): Promise<PinResult> {
  const jwt = requireEnv("PINATA_JWT");
  const res = await fetch(`${PINATA}/${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`pinata ${path}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const json = (await res.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new Error(`pinata ${path}: no IpfsHash in response`);
  return { cid: json.IpfsHash, uri: `ipfs://${json.IpfsHash}` };
}

export async function pinImage(image: FetchedImage, filename: string): Promise<PinResult> {
  const form = new FormData();
  form.set("file", new Blob([image.bytes], { type: image.mime }), filename);
  form.set("pinataMetadata", JSON.stringify({ name: filename }));
  return pinata("pinFileToIPFS", { method: "POST", body: form });
}

export async function pinJson(content: unknown, name: string): Promise<PinResult> {
  return pinata("pinJSONToIPFS", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name } }),
  });
}

export type TokenMetadataInput = {
  name: string;
  symbol: string;
  description?: string;
  /** o1bot token page URL. */
  externalLink?: string;
  /** Attribution to the originating post; verifiable by anyone. */
  launchedBy?: { xHandle: string; xUserId: string; tweetId: string; tweetUrl: string };
  /** Tweet attachment; placeholder is used when missing or rejected. */
  imageUrl?: string | null;
};

export type PreparedMetadata = {
  uri: string;
  imageUri: string;
  imageSource: "tweet" | "placeholder";
  imageRejectReason: ImageRejectReason | null;
  json: Record<string, unknown>;
};

const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Build and pin the token's contract-level metadata. Returns the `ipfs://` URI for `tokenContractURI`. */
export async function prepareTokenMetadata(input: TokenMetadataInput): Promise<PreparedMetadata> {
  let image: FetchedImage;
  let imageSource: PreparedMetadata["imageSource"] = "placeholder";
  let imageRejectReason: ImageRejectReason | null = null;
  const fetched = input.imageUrl ? await fetchTweetImage(input.imageUrl) : null;
  if (fetched?.ok) {
    image = fetched.image;
    imageSource = "tweet";
  } else {
    if (fetched && !fetched.ok) imageRejectReason = fetched.reason;
    image = { bytes: placeholderPng(input.symbol), mime: "image/png" };
  }

  const imagePin = await pinImage(image, `${input.symbol.toLowerCase()}.${EXT[image.mime]}`);
  const json: Record<string, unknown> = {
    name: input.name,
    symbol: input.symbol,
    description: input.description ?? "",
    image: imagePin.uri,
    ...(input.externalLink ? { external_link: input.externalLink } : {}),
    ...(input.launchedBy
      ? {
          launched_by: {
            platform: "x",
            handle: input.launchedBy.xHandle,
            user_id: input.launchedBy.xUserId,
            post_id: input.launchedBy.tweetId,
            post_url: input.launchedBy.tweetUrl,
          },
        }
      : {}),
    generator: "o1bot.exchange",
  };
  const jsonPin = await pinJson(json, `${input.symbol.toLowerCase()}.json`);
  logger.info({ symbol: input.symbol, image: imagePin.uri, metadata: jsonPin.uri, imageSource }, "pinned token metadata");
  return { uri: jsonPin.uri, imageUri: imagePin.uri, imageSource, imageRejectReason, json };
}
