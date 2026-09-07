/**
 * Re-pin every logo and metadata document of the launched tokens into the
 * Pinata account behind PINATA_JWT. Needed after moving to a new Pinata
 * account: a dedicated gateway only serves content pinned in its own
 * account, so older tokens lose their logos until they are pinned again.
 *
 * Content is fetched from a public gateway and uploaded again; IPFS is
 * content-addressed, so the CIDs stay identical and nothing in the
 * database changes. Safe to run repeatedly.
 *
 *   pnpm repin
 */
import "@o1bot/shared/load-env";
import { db } from "@o1bot/db";
import { requireEnv } from "@o1bot/shared";

const PUBLIC_GATEWAYS = ["https://ipfs.io/ipfs", "https://gateway.pinata.cloud/ipfs", "https://dweb.link/ipfs"];

async function fetchFromNetwork(cid: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  for (const gw of PUBLIC_GATEWAYS) {
    try {
      const res = await fetch(`${gw}/${cid}`, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      if (!res.ok) continue;
      return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "application/octet-stream" };
    } catch {
      // try the next gateway
    }
  }
  return null;
}

async function main() {
  const jwt = requireEnv("PINATA_JWT");
  const auth = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${jwt}` } });
  if (!auth.ok) throw new Error(`PINATA_JWT rejected: HTTP ${auth.status}`);

  const pools = await db().pool.findMany({ select: { symbol: true, imageUri: true, metadataUri: true } });
  const items: Array<{ cid: string; name: string }> = [];
  for (const p of pools) {
    if (p.imageUri?.startsWith("ipfs://")) items.push({ cid: p.imageUri.slice(7), name: `${p.symbol.toLowerCase()}-logo` });
    if (p.metadataUri?.startsWith("ipfs://")) items.push({ cid: p.metadataUri.slice(7), name: `${p.symbol.toLowerCase()}.json` });
  }
  let ok = 0;
  for (const { cid, name } of items) {
    const content = await fetchFromNetwork(cid);
    if (!content) {
      console.log(`SKIP  ${name.padEnd(20)} ${cid}  not reachable on public gateways`);
      continue;
    }
    const form = new FormData();
    const buffer = content.bytes.buffer.slice(content.bytes.byteOffset, content.bytes.byteOffset + content.bytes.byteLength) as ArrayBuffer;
    form.set("file", new Blob([buffer], { type: content.type.split(";")[0] }), name);
    form.set("pinataMetadata", JSON.stringify({ name }));
    // CIDv0 for files, matching what the bot pinned originally, so the hash comes back identical.
    form.set("pinataOptions", JSON.stringify({ cidVersion: 0 }));
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form, signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as { IpfsHash?: string; error?: unknown };
    if (!res.ok) {
      console.log(`FAIL  ${name.padEnd(20)} ${cid}  HTTP ${res.status} ${JSON.stringify(body.error ?? "").slice(0, 100)}`);
      continue;
    }
    const same = body.IpfsHash === cid;
    console.log(`${same ? "ok   " : "WARN "} ${name.padEnd(20)} ${cid}${same ? "" : `  re-pinned as ${body.IpfsHash} (different CID: the original was pinned with other options)`}`);
    if (same) ok++;
  }
  console.log(`\n${ok}/${items.length} pinned with identical CIDs`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
