/**
 * Vendor verified ABIs for the active o1 suite on every supported chain.
 *
 * For each contract the ABI is fetched from two independent verification
 * sources (Sourcify and the chain's Blockscout) and the script refuses to
 * write anything when both exist and disagree. Where Sourcify has no entry
 * (the Base factory and fee escrow, verified on Blockscout only) the
 * Blockscout ABI is vendored alone, the provenance says so, and the ABI is
 * cross-checked against the Robinhood contract of the same role: every
 * function the two share must have an identical signature. Output per
 * contract:
 *
 *   abis/<Name>.<chainId>.<address>.json   verbatim ABI + provenance
 *   abis/<Name>.<chainId>.<address>.ts     `as const` export for viem typing
 *   abis/index.ts                          re-exports
 *
 * Run: pnpm abi:vendor   (re-run after `pnpm o1:sync` reports drift)
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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

type ChainKey = "robinhood" | "base";
type Target = { name: string; exportName: string; key: string; role: "factory" | "hook" | "feeEscrow" | "tokenDeployer" };

/** Blockscout instances: o1's explorer field is Blockscout on Robinhood, Basescan on Base. */
const BLOCKSCOUT: Record<ChainKey, string> = {
  robinhood: o1.chains.robinhood.explorer,
  base: "https://base.blockscout.com",
};

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
};

async function fetchSourcify(chainId: number, address: string): Promise<{ abi: AbiItem[]; contractName: string; compilerVersion: string } | null> {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi,compilation`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sourcify ${address}: HTTP ${res.status}`);
  const json = (await res.json()) as { abi?: AbiItem[]; match?: string | null; compilation?: { name?: string; compilerVersion?: string } };
  if (!json.match || !Array.isArray(json.abi)) return null;
  return { abi: json.abi, contractName: json.compilation?.name ?? "", compilerVersion: json.compilation?.compilerVersion ?? "" };
}

async function fetchBlockscout(chain: ChainKey, address: string): Promise<{ abi: AbiItem[]; contractName: string; compilerVersion: string }> {
  const url = `${BLOCKSCOUT[chain]}/api?module=contract&action=getabi&address=${address.toLowerCase()}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`blockscout ${address}: HTTP ${res.status}`);
  const json = (await res.json()) as { status: string; result: string | null; message?: string };
  if (json.status !== "1" || !json.result) throw new Error(`blockscout ${address}: ${json.message ?? "not verified"}`);
  const meta = await fetch(`${BLOCKSCOUT[chain]}/api/v2/smart-contracts/${address}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  const m = meta.ok ? ((await meta.json()) as { name?: string; compiler_version?: string }) : {};
  return { abi: JSON.parse(json.result) as AbiItem[], contractName: m.name ?? "", compilerVersion: m.compiler_version ?? "" };
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

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(root, "abis");
  await mkdir(outDir, { recursive: true });
  const verifiedAt = new Date().toISOString();
  const indexLines: string[] = ["// Generated by scripts/vendor-abi.ts — do not edit by hand."];
  const reference = new Map<Target["role"], AbiItem[]>();

  for (const chainKey of ["robinhood", "base"] as const) {
    const chain = o1.chains[chainKey];
    const chainId = chain.chainId;
    for (const c of TARGETS[chainKey]) {
      const address = (chain.contracts as Record<string, string>)[c.key];
      if (!address) throw new Error(`config/o1.json: ${chainKey} has no ${c.key}`);
      const base = `${c.name}.${chainId}.${address}`;
      const sourcify = await fetchSourcify(chainId, address);
      let blockscout: Awaited<ReturnType<typeof fetchBlockscout>> | null;
      try {
        blockscout = await fetchBlockscout(chainKey, address);
      } catch (err) {
        // Robinhood's Blockscout sits behind Cloudflare and rejects some networks. A previously
        // vendored ABI that still matches Sourcify keeps the two-source guarantee it was written with.
        blockscout = null;
        const previous = await readFile(path.join(outDir, `${base}.json`), "utf8").then((t) => (JSON.parse(t) as { abi: AbiItem[] }).abi, () => null);
        if (!sourcify || !previous || canonical(previous) !== canonical(sourcify.abi)) throw err;
        console.warn(`${chainKey} ${c.name}: Blockscout unreachable (${(err as Error).message.slice(0, 60)}); Sourcify matches the previously vendored ABI, keeping it`);
      }
      if (sourcify && blockscout && canonical(sourcify.abi) !== canonical(blockscout.abi)) {
        throw new Error(`${chainKey} ${c.name} ${address}: Sourcify and Blockscout ABIs differ; refusing to vendor`);
      }
      const chosen = sourcify ?? blockscout;
      if (!chosen) throw new Error(`${chainKey} ${c.name} ${address}: no verification source reachable`);
      // Cross-chain check: the same role on another chain must agree on every shared function.
      const ref = reference.get(c.role);
      if (ref) {
        const a = signatures(ref);
        const b = signatures(chosen.abi);
        for (const [name, sig] of b) {
          const other = a.get(name);
          if (other && other !== sig) throw new Error(`${chainKey} ${c.name}: function ${name} differs from the Robinhood contract; refusing to vendor`);
        }
      } else reference.set(c.role, chosen.abi);
      if (!sourcify && !ref) throw new Error(`${chainKey} ${c.name} ${address}: only one verification source and nothing to compare against`);

      const meta = {
        name: c.name,
        contractName: chosen.contractName,
        chainId,
        address,
        compilerVersion: chosen.compilerVersion,
        verifiedAt,
        sources: {
          sourcify: sourcify ? `https://sourcify.dev/server/v2/contract/${chainId}/${address}` : null,
          blockscout: `${BLOCKSCOUT[chainKey]}/address/${address}?tab=contract`,
          ...(sourcify ? {} : { note: "Not on Sourcify; Blockscout ABI cross-checked against the Robinhood contract of the same role." }),
        },
      };
      await writeFile(path.join(outDir, `${base}.json`), JSON.stringify({ ...meta, abi: chosen.abi }, null, 2) + "\n");
      await writeFile(path.join(outDir, `${base}.ts`), tsFile(c.exportName, meta, chosen.abi));
      indexLines.push(`export { ${c.exportName} } from "./${base}";`);
      console.log(`vendored ${chainKey} ${c.name} (${chosen.contractName}, ${chosen.compilerVersion}) at ${address}: ${chosen.abi.length} items${sourcify ? "" : " [blockscout only]"}`);
    }
  }

  await writeFile(path.join(outDir, "index.ts"), indexLines.join("\n") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
