import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_RPCS, logsRpcUrls, rpcUrls } from "../src/chains";
import { resetEnvCache } from "../src/env";

const KEYS = ["RPC_ROBINHOOD", "RPC_BASE", "RPC_ARC", "INDEXER_RPC"] as const;
type Key = (typeof KEYS)[number];

const saved: Partial<Record<Key, string>> = {};
for (const k of KEYS) if (process.env[k] !== undefined) saved[k] = process.env[k];

function withEnv(values: Partial<Record<Key, string>>): void {
  for (const k of KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

afterEach(() => withEnv(saved));

const PAID = "https://robinhood-mainnet.g.alchemy.com/v2/key";
const ORDOFI = "https://rpc.ordofi.network";

describe("rpcUrls", () => {
  it("uses the public list when no RPC_* is set", () => {
    withEnv({});
    expect(rpcUrls("robinhood")).toEqual([...PUBLIC_RPCS.robinhood]);
    expect(rpcUrls("base")).toEqual([...PUBLIC_RPCS.base]);
  });

  it("puts RPC_* first and keeps the public list behind it, so a dead paid endpoint degrades instead of failing", () => {
    withEnv({ RPC_ROBINHOOD: PAID, RPC_BASE: "https://base.example/v2/key" });
    expect(rpcUrls("robinhood")).toEqual([PAID, ...PUBLIC_RPCS.robinhood]);
    expect(rpcUrls("base")).toEqual(["https://base.example/v2/key", ...PUBLIC_RPCS.base]);
  });

  it("does not list an override twice when it is one of the public URLs", () => {
    withEnv({ RPC_ROBINHOOD: ORDOFI });
    const urls = rpcUrls("robinhood");
    expect(urls[0]).toBe(ORDOFI);
    expect(urls.filter((u) => u === ORDOFI)).toHaveLength(1);
    expect(urls).toHaveLength(PUBLIC_RPCS.robinhood.length);
  });
});

describe("logsRpcUrls", () => {
  it("scans Robinhood from ordofi first when nothing is set: publicnode refuses archive log ranges", () => {
    withEnv({});
    const urls = logsRpcUrls("robinhood");
    expect(urls[0]).toBe(ORDOFI);
    expect(new Set(urls)).toEqual(new Set(PUBLIC_RPCS.robinhood));
  });

  it("prefers INDEXER_RPC over RPC_ROBINHOOD and keeps ordofi as the next hop", () => {
    withEnv({ INDEXER_RPC: PAID, RPC_ROBINHOOD: "https://other.example" });
    expect(logsRpcUrls("robinhood").slice(0, 2)).toEqual([PAID, ORDOFI]);
  });

  it("falls back to RPC_ROBINHOOD when INDEXER_RPC is unset", () => {
    withEnv({ RPC_ROBINHOOD: PAID });
    expect(logsRpcUrls("robinhood")[0]).toBe(PAID);
  });

  it("uses the chain's own RPC_* then its public list on Base and Arc", () => {
    withEnv({ RPC_BASE: "https://base.example", RPC_ARC: "https://rpc.arc-scan.org" });
    expect(logsRpcUrls("base")).toEqual(["https://base.example", ...PUBLIC_RPCS.base]);
    expect(logsRpcUrls("arc")).toEqual([...PUBLIC_RPCS.arc]);
  });
});
