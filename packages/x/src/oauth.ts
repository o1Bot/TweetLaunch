import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a request signing (HMAC-SHA1) for posting as the bot account.
 * Reading mentions uses the app Bearer token; only writes need this.
 *
 * Signature base string = METHOD & url & sorted(oauth_* + query + form params).
 * A JSON body is NOT part of the signature; form-encoded bodies are.
 */

export type OAuthCredentials = {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
};

export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function signatureBaseString(method: string, url: string, params: Record<string, string>): string {
  const normalized = Object.keys(params)
    .map((k) => [percentEncode(k), percentEncode(params[k] as string)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(normalized)}`;
}

export function hmacSha1Signature(baseString: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString).digest("base64");
}

export type OAuthHeaderOptions = {
  /** Query or form parameters that are part of the request (never a JSON body). */
  params?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
};

/** Build the `Authorization: OAuth …` header value for one request. */
export function oauthAuthorizationHeader(method: string, url: string, creds: OAuthCredentials, opts: OAuthHeaderOptions = {}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const base = signatureBaseString(method, url, { ...oauth, ...(opts.params ?? {}) });
  const signature = hmacSha1Signature(base, creds.consumerSecret, creds.tokenSecret);
  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(header)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(header[k]!)}"`)
      .join(", ")
  );
}
