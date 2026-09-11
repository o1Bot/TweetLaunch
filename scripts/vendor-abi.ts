/**
 * Vendor verified ABIs for the active o1 suite on every supported chain.
 *
 * For each contract the ABI is fetched from two independent verification
 * sources (Sourcify and the chain's explorer) and the script refuses to
 * write anything when both exist and disagree. Where Sourcify has no entry
 * (the Base factory and fee escrow, verified on Blockscout only) the
 * explorer ABI is vendored alone, the provenance says so, and the ABI is
 * cross-checked against the Robinhood contract of the same role: every
 * function the two share must have an identical signature.
 *
 * Arc (2026-09-12): Sourcify does not index chain 5042 and o1's contracts
 * are not verified on Arcscan, so no source can give an ABI. They are the
 * same `launchpad-v4-minimal` family as Robinhood's, so the Robinhood ABI
 * of the same role is mirrored, and the mirror is justified by comparing
 * runtime bytecode over RPC: same length, and only the few 32-byte words
 * that hold immutables (addresses set in the constructor) may differ.
 * Without a reachable Arc RPC the mirror is written unchecked only when
 * `--allow-unchecked` is passed, and the provenance says so; re-run with
 * RPC_ARC set to upgrade it. The executor reads the live factory and
 * simulates before anything is signed, so a wrong ABI fails closed.
 *
 * Output per contract:
 *
 *   abis/<Name>.<chainId>.<address>.json   verbatim ABI + provenance
 *   abis/<Name>.<chainId>.<address>.ts     `as const` export for viem typing
 *   abis/index.ts                          re-exports
 *
 * Run: pnpm abi:vendor [--only <chain>] [--allow-unchecked]
 * (re-run after `pnpm o1:sync` reports drift; `--only` re-fetches one chain
 * and keeps the others' files as they are)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import o1 from "../config/o1.json" with { type: "json" };

type AbiItem = {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  anonymous?: boolean;
};
type AbiParam = { name: string; type: string; internalType?: string; indexed?: boolean; components?: AbiParam[] };
type Verified = { abi: AbiItem[]; contractName: string; compilerVersion: string };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

type ChainKey = "robinhood" | "base" | "arc";
type Role = "factory" | "hook" | "feeEscrow" | "tokenDeployer";
type Target = { name: string; exportName: string; key: string; role: Role };

const CHAIN_ORDER: readonly ChainKey[] = ["robinhood", "base", "arc"];

/** Explorer contract APIs: Blockscout on Robinhood and Base, an Etherscan-style API on Arc. */
const EXPLORER_API: Record<ChainKey, { api: string; site: string; kind: "blockscout" | "etherscan" }> = {
  robinhood: { api: `${o1.chains.robinhood.explorer}/api`, site: o1.chains.robinhood.explorer, kind: "blockscout" },
  base: { api: "https://base.blockscout.com/api", site: "https://base.blockscout.com", kind: "blockscout" },
  arc: { api: "https://api.arc-scan.org/api", site: o1.chains.arc.explorer, kind: "etherscan" },
};

/** Public RPCs for the bytecode comparison; RPC_<CHAIN> in the environment wins. */
const RPC: Record<ChainKey, string[]> = {
  robinhood: [process.env.RPC_ROBINHOOD ?? "", "https://robinhood-rpc.publicnode.com", "https://rpc.ordofi.network"].filter(Boolean),
  base: [process.env.RPC_BASE ?? "", "https://base-rpc.publicnode.com", "https://mainnet.base.org"].filter(Boolean),
  arc: [process.env.RPC_ARC ?? "", "https://5042.rpc.thirdweb.com"].filter(Boolean),
};

/** Immutables of these contracts fit in a handful of words; more differences than this means different code. */
const MAX_IMMUTABLE_WORDS = 16;

const TARGETS: Record<ChainKey, Target[]> = {
  robinhood: [
    { name: "LaunchFactory", exportName: "launchFactoryAbi", key: "factory", role: "factory" },
    { name: "LaunchHook", exportName: "launchHookAbi", key: "hook", role: "hook" },
    { name: "FeeEscrow", exportName: "feeEscrowAbi", key: "feeEscrow", role: "feeEscrow" },
    { name: "LaunchTokenDeployer", exportName: "launchTokenDeployerAbi", key: "launchTokenDeployer", role: "tokenDeployer" },
  ],
  base: [
    { name: "LaunchFactory", exportName: "baseLaunchFactoryAbi", key: "factory", role: "factory" },
    { name: "LaunchHook", exportName: "baseLaunchHookAbi", key: "hook", role: "hook" },
    { name: "FeeEscrow", exportName: "baseFeeEscrowAbi", key: "feeEscrow", role: "feeEscrow" },
  ],
  arc: [
    { name: "LaunchFactory", exportName: "arcLaunchFactoryAbi", key: "factory", role: "factory" },
    { name: "LaunchHook", exportName: "arcLaunchHookAbi", key: "hook", role: "hook" },
    { name: "FeeEscrow", exportName: "arcFeeEscrowAbi", key: "feeEscrow", role: "feeEscrow" },
    { name: "LaunchTokenDeployer", exportName: "arcLaunchTokenDeployerAbi", key: "launchTokenDeployer", role: "tokenDeployer" },
  ],
};

async function fetchSourcify(chainId: number, address: string): Promise<Verified | null> {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi,compilation`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  if (!res.ok) {
    // Sourcify answers 400 with `unsupported_chain` for chains it does not index (Arc).
    const body = await res.text().catch(() => "");
    if (res.status === 400 && /unsupported_chain/.test(body)) return null;
    throw new Error(`sourcify ${address}: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { abi?: AbiItem[]; match?: string | null; compilation?: { name?: string; compilerVersion?: string } };
  if (!json.match || !Array.isArray(json.abi)) return null;
  return { abi: json.abi, contractName: json.compilation?.name ?? "", compilerVersion: json.compilation?.compilerVersion ?? "" };
}

class NotVerified extends Error {}

async function fetchExplorer(chain: ChainKey, address: string): Promise<Verified> {
  const { api, kind } = EXPLORER_API[chain];
  const url = `${api}?module=contract&action=getabi&address=${address.toLowerCase()}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${kind} ${address}: HTTP ${res.status}`);
  const json = (await res.json()) as { status: string; result: string | null; message?: string };
  if (json.status !== "1" || !json.result) {
    const reason = json.result ?? json.message ?? "not verified";
    if (/not verified/i.test(reason)) throw new NotVerified(`${kind} ${address}: ${reason}`);
    throw new Error(`${kind} ${address}: ${reason}`);
  }
  let contractName = "";
  let compilerVersion = "";
  if (kind === "blockscout") {
    const meta = await fetch(`${api}/v2/smart-contracts/${address}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    const m = meta.ok ? ((await meta.json()) as { name?: string; compiler_version?: string }) : {};
    contractName = m.name ?? "";
    compilerVersion = m.compiler_version ?? "";
  } else {
    const src = await fetch(`${api}?module=contract&action=getsourcecode&address=${address.toLowerCase()}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    const s = src.ok ? ((await src.json()) as { result?: Array<{ ContractName?: string; CompilerVersion?: string }> }) : {};
    contractName = s.result?.[0]?.ContractName ?? "";
    compilerVersion = s.result?.[0]?.CompilerVersion ?? "";
  }
  return { abi: JSON.parse(json.result) as AbiItem[], contractName, compilerVersion };
}

async function getCode(chain: ChainKey, address: string): Promise<string> {
  let last: unknown = null;
  for (const url of RPC[chain]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as { result?: string; error?: { message?: string } };
      if (typeof json.result === "string" && json.result.length > 2) return json.result;
      last = json.error?.message ?? `no code at ${address}`;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`eth_getCode ${chain} ${address}: ${last instanceof Error ? last.message : String(last)}`);
}

/** Runtime code comparison: same length and only immutable words differing means the same compiled contract. */
function compareCode(a: string, b: string): { sameLength: boolean; length: number; differingWords: number } {
  const x = Buffer.from(a.slice(2), "hex");
  const y = Buffer.from(b.slice(2), "hex");
  if (x.length !== y.length) return { sameLength: false, length: x.length, differingWords: -1 };
  const words = new Set<number>();
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) words.add(Math.floor(i / 32));
  return { sameLength: true, length: x.length, differingWords: words.size };
}

/** Canonical form that ignores ordering and internalType noise. */
function canonical(abi: AbiItem[]): string {
  const param = (p: AbiParam): unknown => [p.name, p.type, p.indexed ?? false, (p.components ?? []).map(param)];
  const items = abi
    .map((i) => [i.type, i.name ?? "", i.stateMutability ?? "", (i.inputs ?? []).map(param), (i.outputs ?? []).map(param)])
    .map((x) => JSON.stringify(x))
    .sort();
  return JSON.stringify(items);
}

/** name → canonical signature of every function, for cross-chain comparison. */
function signatures(abi: AbiItem[]): Map<string, string> {
  const param = (p: AbiParam): unknown => [p.type, (p.components ?? []).map(param)];
  const out = new Map<string, string>();
  for (const i of abi) {
    if (i.type !== "function" || !i.name) continue;
    out.set(i.name, JSON.stringify([i.stateMutability ?? "", (i.inputs ?? []).map(param), (i.outputs ?? []).map(param)]));
  }
  return out;
}

function tsFile(exportName: string, meta: Record<string, unknown>, abi: AbiItem[]): string {
  return (
    `// Generated by scripts/vendor-abi.ts — do not edit by hand.\n` +
    `// ${JSON.stringify(meta)}\n` +
    `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`
  );
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(root, "abis");
  await mkdir(outDir, { recursive: true });
  const verifiedAt = new Date().toISOString();
  const only = argValue("--only") as ChainKey | null;
  if (only && !CHAIN_ORDER.includes(only)) throw new Error(`--only: unknown chain ${only}`);
  const allowUnchecked = process.argv.includes("--allow-unchecked");
  const indexLines: string[] = ["// Generated by scripts/vendor-abi.ts — do not edit by hand."];
  const reference = new Map<Role, { abi: AbiItem[]; chain: ChainKey; address: string }>();

  for (const chainKey of CHAIN_ORDER) {
    const chain = o1.chains[chainKey];
    const chainId = chain.chainId;
    for (const c of TARGETS[chainKey]) {
      const address = (chain.contracts as Record<string, string>)[c.key];
      if (!address) throw new Error(`config/o1.json: ${chainKey} has no ${c.key}`);
      const base = `${c.name}.${chainId}.${address}`;
      const previous = await readFile(path.join(outDir, `${base}.json`), "utf8").then((t) => JSON.parse(t) as { abi: AbiItem[] }, () => null);

      // With --only, every other chain keeps what it has and still serves as the cross-chain reference.
      if (only && chainKey !== only) {
        if (!previous) throw new Error(`${chainKey} ${c.name}: no vendored ABI to keep; run without --only`);
        if (!reference.has(c.role)) reference.set(c.role, { abi: previous.abi, chain: chainKey, address });
        indexLines.push(`export { ${c.exportName} } from "./${base}";`);
        continue;
      }

      const sourcify = await fetchSourcify(chainId, address);
      let explorer: Verified | null = null;
      let unverified = false;
      try {
        explorer = await fetchExplorer(chainKey, address);
      } catch (err) {
        if (err instanceof NotVerified) {
          unverified = true;
        } else {
          // Robinhood's Blockscout sits behind Cloudflare and rejects some networks. A previously
          // vendored ABI that still matches Sourcify keeps the two-source guarantee it was written with.
          if (!sourcify || !previous || canonical(previous.abi) !== canonical(sourcify.abi)) throw err;
          console.warn(`${chainKey} ${c.name}: explorer unreachable (${(err as Error).message.slice(0, 60)}); Sourcify matches the previously vendored ABI, keeping it`);
        }
      }
      if (sourcify && explorer && canonical(sourcify.abi) !== canonical(explorer.abi)) {
        throw new Error(`${chainKey} ${c.name} ${address}: Sourcify and explorer ABIs differ; refusing to vendor`);
      }
      const ref = reference.get(c.role);
      let chosen = sourcify ?? explorer;
      let mirror: Record<string, unknown> | null = null;

      if (!chosen) {
        // No verification source at all: mirror the reference contract of the same role, justified by bytecode.
        if (!unverified || !ref) throw new Error(`${chainKey} ${c.name} ${address}: no verification source reachable`);
        let check: Record<string, unknown>;
        try {
          const [here, there] = await Promise.all([getCode(chainKey, address), getCode(ref.chain, ref.address)]);
          const cmp = compareCode(here, there);
          if (!cmp.sameLength || cmp.differingWords > MAX_IMMUTABLE_WORDS) {
            throw new Error(`${chainKey} ${c.name} ${address}: runtime code differs from ${ref.chain} ${ref.address} (sameLength=${cmp.sameLength}, differingWords=${cmp.differingWords}); refusing to mirror`);
          }
          check = { checked: true, checkedAt: verifiedAt, length: cmp.length, differingWords: cmp.differingWords, maxImmutableWords: MAX_IMMUTABLE_WORDS };
        } catch (err) {
          if (!allowUnchecked || /refusing to mirror/.test((err as Error).message)) throw err;
          check = { checked: false, reason: (err as Error).message.slice(0, 160) };
          console.warn(`${chainKey} ${c.name}: bytecode check skipped (${check.reason}); mirroring unchecked because --allow-unchecked was passed`);
        }
        chosen = { abi: ref.abi, contractName: `${c.name} (mirrored)`, compilerVersion: "" };
        mirror = { from: { chain: ref.chain, address: ref.address }, bytecode: check, note: `Not verified on ${EXPLORER_API[chainKey].site} nor indexed by Sourcify on ${verifiedAt.slice(0, 10)}; ABI mirrored from the ${ref.chain} contract of the same role.` };
      } else if (ref) {
        // Cross-chain check: the same role on another chain must agree on every shared function.
        const a = signatures(ref.abi);
        const b = signatures(chosen.abi);
        for (const [name, sig] of b) {
          const other = a.get(name);
          if (other && other !== sig) throw new Error(`${chainKey} ${c.name}: function ${name} differs from the ${ref.chain} contract; refusing to vendor`);
        }
      } else if (!sourcify) {
        throw new Error(`${chainKey} ${c.name} ${address}: only one verification source and nothing to compare against`);
      }
      if (!ref) reference.set(c.role, { abi: chosen.abi, chain: chainKey, address });

      const meta = {
        name: c.name,
        contractName: chosen.contractName,
        chainId,
        address,
        compilerVersion: chosen.compilerVersion,
        verifiedAt,
        sources: {
          sourcify: sourcify ? `https://sourcify.dev/server/v2/contract/${chainId}/${address}` : null,
          explorer: `${EXPLORER_API[chainKey].site}/address/${address}`,
          ...(mirror ? { mirror } : sourcify ? {} : { note: `Not on Sourcify; explorer ABI cross-checked against the ${ref?.chain ?? "reference"} contract of the same role.` }),
        },
      };
      await writeFile(path.join(outDir, `${base}.json`), JSON.stringify({ ...meta, abi: chosen.abi }, null, 2) + "\n");
      await writeFile(path.join(outDir, `${base}.ts`), tsFile(c.exportName, meta, chosen.abi));
      indexLines.push(`export { ${c.exportName} } from "./${base}";`);
      console.log(`vendored ${chainKey} ${c.name} (${chosen.contractName}${chosen.compilerVersion ? `, ${chosen.compilerVersion}` : ""}) at ${address}: ${chosen.abi.length} items${mirror ? " [mirrored]" : sourcify ? "" : " [explorer only]"}`);
    }
  }

  await writeFile(path.join(outDir, "index.ts"), indexLines.join("\n") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
