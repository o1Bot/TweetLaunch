import type { Address, PublicClient } from "viem";
import { launchFactoryAbi, launchHookAbi } from "./abis";

/**
 * Everything the factory would freeze into a new launch, read at ONE block so
 * the values are mutually consistent. Never build a transaction from the
 * config/o1.json snapshot; read this first.
 */
export type FactoryState = {
  blockNumber: bigint;
  configVersion: bigint;
  launchSupply: bigint;
  tickSpacing: number;
  nativeLaunchFee: bigint;
  launchCreationEnabled: boolean;
  tokenAddressSuffix: number;
  tokenDeployer: Address;
  hook: Address;
  launchBuyAdapter: Address;
  platformFeeRecipient: Address;
  baseFeeBps: number;
  antiSnipeStartTotalBps: number;
  antiSnipeWindowSeconds: number;
};

export async function readFactoryState(client: PublicClient, factory: Address, blockNumber: bigint): Promise<FactoryState> {
  const c = { address: factory, abi: launchFactoryAbi } as const;
  const [
    configVersion,
    launchSupply,
    tickSpacing,
    nativeLaunchFee,
    launchCreationEnabled,
    tokenAddressSuffix,
    tokenDeployer,
    hook,
    platformFeeRecipient,
    baseFeeBps,
    antiSnipeStartTotalBps,
    antiSnipeWindowSeconds,
  ] = await client.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      { ...c, functionName: "configVersion" },
      { ...c, functionName: "launchSupply" },
      { ...c, functionName: "tickSpacing" },
      { ...c, functionName: "nativeLaunchFee" },
      { ...c, functionName: "launchCreationEnabled" },
      { ...c, functionName: "TOKEN_ADDRESS_SUFFIX" },
      { ...c, functionName: "tokenDeployer" },
      { ...c, functionName: "hook" },
      { ...c, functionName: "platformFeeRecipient" },
      { ...c, functionName: "baseFeeBps" },
      { ...c, functionName: "antiSnipeStartTotalBps" },
      { ...c, functionName: "antiSnipeWindowSeconds" },
    ],
  });
  const launchBuyAdapter = await client.readContract({ address: hook, abi: launchHookAbi, functionName: "launchBuyAdapter", blockNumber });
  return {
    blockNumber,
    configVersion,
    launchSupply,
    tickSpacing,
    nativeLaunchFee,
    launchCreationEnabled,
    tokenAddressSuffix,
    tokenDeployer,
    hook,
    launchBuyAdapter,
    platformFeeRecipient,
    baseFeeBps,
    antiSnipeStartTotalBps,
    antiSnipeWindowSeconds,
  };
}

export type QuoteState = {
  registered: boolean;
  quoteDecimals: number;
  startTickToken0Frame: number;
  revision: bigint;
};

export async function readQuoteState(client: PublicClient, factory: Address, quote: Address, blockNumber: bigint): Promise<QuoteState> {
  const c = { address: factory, abi: launchFactoryAbi } as const;
  const [config, revision] = await client.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      { ...c, functionName: "quoteConfig", args: [quote] },
      { ...c, functionName: "quoteRevision", args: [quote] },
    ],
  });
  const [registered, quoteDecimals, startTickToken0Frame] = config;
  return { registered, quoteDecimals, startTickToken0Frame, revision };
}

/** Bytecode hash of the token the factory would deploy for these params (salt-independent). */
export async function readTokenBytecodeHash(
  client: PublicClient,
  factory: Address,
  params: {
    tokenName: string;
    tokenSymbol: string;
    tokenContractURI: string;
    creatorSalt: `0x${string}`;
    quoteToken: Address;
    expectedConfigVersion: bigint;
    deadline: bigint;
    metadataEditable: boolean;
    metadataKeys: readonly string[];
    metadataValues: readonly string[];
  },
  blockNumber: bigint,
): Promise<`0x${string}`> {
  return client.readContract({ address: factory, abi: launchFactoryAbi, functionName: "launchTokenBytecodeHash", args: [params], blockNumber });
}
