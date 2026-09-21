// API key vault — AES-GCM with a key derived from a wallet signature over a
// deterministic message. The signature is never stored; the encrypted blob in
// localStorage is useless without the wallet. Lighter API keys carry full write
// permission, so the plaintext must never touch disk or a server.

// The first line is a domain separator: it must differ per app, or a signature
// collected by one app derives the same vault key as another's.
export const VAULT_MESSAGE =
  "o1bot signer vault v1\n\n" +
  "this signature derives the local encryption key for your lighter api key.\n" +
  "it costs nothing and authorises nothing on-chain.";

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment");
  return c.subtle;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function keyFromSignature(signature: string): Promise<CryptoKey> {
  const digest = await subtle().digest("SHA-256", hexToBytes(signature).buffer as ArrayBuffer);
  return subtle().importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt the API private key → `base64(iv).base64(ciphertext)` blob. */
export async function sealApiKey(privateKey: string, signature: string): Promise<string> {
  const key = await keyFromSignature(signature);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(privateKey),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

/** Open a vault blob. Throws if the signature (= wallet) does not match. */
export async function openApiKey(blob: string, signature: string): Promise<string> {
  const [ivB64, ctB64] = blob.split(".");
  if (!ivB64 || !ctB64) throw new Error("corrupt vault blob");
  const key = await keyFromSignature(signature);
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64).buffer as ArrayBuffer },
    key,
    fromBase64(ctB64).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(pt);
}
