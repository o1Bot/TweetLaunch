import { env, logger } from "@o1bot/shared";

/**
 * o1's token pages and Public API only show a launch's logo, description and
 * links when the metadata document is pinned in o1's own Pinata account:
 * their gateway runs in restricted mode and answers 403 for any other CID,
 * so a document pinned by o1bot alone leaves the token blank on o1.
 *
 * `POST /launches/prepare` on the o1 Public API pins the image and the
 * ERC-7572 document through that account and returns their URIs. The bot
 * asks o1 to pin, then builds and signs its own transaction as before (the
 * API does not expose the atomic dev buy); the prepared steps in the
 * response are ignored. Any failure here falls back to o1bot's own Pinata.
 */

/** o1's dedicated gateway, taken from the image URLs their API returns. */
export const O1_GATEWAY = "https://sapphire-negative-junglefowl-959.mypinata.cloud/ipfs/";

export type O1Market = "standard" | "rwa";

export type O1PinInput = {
  chainId: number;
  /** Wallet that will send the launch; o1 checks it holds the creation fee before pinning. */
  creator: string;
  market: O1Market;
  quoteAddress: string;
  name: string;
  symbol: string;
  description: string;
  image: { bytes: Uint8Array; mime: string };
  website?: string | null;
  x?: string | null;
  telegram?: string | null;
};

export type O1PinResult = {
  /** `ipfs://` URI of the ERC-7572 document, for `tokenContractURI`. */
  metadataUri: string;
  /** `ipfs://` URI of the logo when the gateway URL carries a CID, else the URL itself. */
  imageUri: string;
  /** Gateway URL o1 itself will serve the logo from. */
  imageUrl: string;
};

export class O1PinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "O1PinError";
  }
}

// The API's own validation patterns; a link that fails them is dropped
// rather than failing the whole request.
const WEBSITE_RE = /^https?:\/\/[^/]*\.[^/]+(?:\/.*)?$/;
const X_RE = /^https?:\/\/(?:www\.)?x\.com\/.+/;
const TELEGRAM_RE = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/.+/;
const DESCRIPTION_MAX_BYTES = 2000;

function link(value: string | null | undefined, re: RegExp): string {
  const v = (value ?? "").trim();
  return v.length <= 2048 && re.test(v) ? v : "";
}

function trimUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

/** `https://gateway/ipfs/<cid>` on any host → `ipfs://<cid>`; other URLs are kept. */
export function toIpfsUri(url: string): string {
  const m = url.match(/\/ipfs\/([^/?#]+)/);
  return m ? `ipfs://${m[1]}` : url;
}

export function o1PinConfigured(): boolean {
  return Boolean(env().O1_API_KEY);
}

/** Request body for `/launches/prepare`, exported for tests. */
export function o1PinBody(input: O1PinInput): Record<string, unknown> {
  return {
    chain_id: input.chainId,
    creator: input.creator,
    market: input.market,
    quote_address: input.quoteAddress,
    token: {
      name: input.name,
      symbol: input.symbol,
      description: trimUtf8(input.description, DESCRIPTION_MAX_BYTES),
      image_base64: Buffer.from(input.image.bytes).toString("base64"),
      image_type: input.image.mime,
      website: link(input.website, WEBSITE_RE),
      x: link(input.x, X_RE),
      telegram: link(input.telegram, TELEGRAM_RE),
      editable_metadata: false,
      extra_metadata: [],
    },
  };
}

type ProblemJson = { code?: string; detail?: string; title?: string };
type PrepareJson = { data?: { metadata_uri?: string; image_url?: string | null } };

/** Ask o1 to pin the logo and metadata document. Throws `O1PinError` on any refusal. */
export async function pinViaO1(input: O1PinInput, fetchImpl: typeof fetch = fetch): Promise<O1PinResult> {
  const e = env();
  const key = e.O1_API_KEY;
  if (!key) throw new O1PinError("O1_API_KEY is not set", 0, null);
  const url = `${e.O1_API_URL.replace(/\/$/, "")}/launches/prepare`;
  // o1 mines a salt and simulates the launch before answering; allow for that.
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(o1PinBody(input)),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let problem: ProblemJson = {};
    try {
      problem = JSON.parse(text) as ProblemJson;
    } catch {
      // Not a problem document; the status is all we have.
    }
    const detail = (problem.detail ?? problem.title ?? text).replace(/\s+/g, " ").slice(0, 200);
    throw new O1PinError(`o1 prepare HTTP ${res.status}${problem.code ? ` ${problem.code}` : ""}: ${detail}`, res.status, problem.code ?? null);
  }
  let json: PrepareJson;
  try {
    json = JSON.parse(text) as PrepareJson;
  } catch {
    throw new O1PinError("o1 prepare: response is not JSON", res.status, null);
  }
  const metadataUri = json.data?.metadata_uri;
  const imageUrl = json.data?.image_url;
  if (!metadataUri?.startsWith("ipfs://") || !imageUrl) throw new O1PinError("o1 prepare: no metadata_uri or image_url in response", res.status, null);
  logger.info({ symbol: input.symbol, metadata: metadataUri, image: imageUrl }, "o1 pinned the token metadata");
  return { metadataUri, imageUri: toIpfsUri(imageUrl), imageUrl };
}
