// Direct deposit into Lighter from Ethereum mainnet.
//
// Verified 2026-07-31 against apidocs.lighter.xyz and by recomputing the selector
// locally: `deposit(address,uint16,uint8,uint256)` == 0x8a857083. Arguments are
// (recipient L1 address, asset id, route, amount in the ERC20's own decimals).
// Non-ETH assets need an ERC20 approve to the bridge first. Minimum 1 USDC.
//
// This module only describes the call; it never holds keys. The transaction is
// signed by the user's wallet in the browser.

/** Lighter's L1 bridge on Ethereum mainnet (layer1BasicInfo → ZkLighterContract). */
export const LIGHTER_BRIDGE_ADDRESS = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7" as const;

/** Canonical USDC on Ethereum mainnet (layer1BasicInfo → USDCContract), 6 decimals. */
export const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;

export const USDC_ASSET_ID = 3;
export const USDC_DECIMALS = 6;

/** Where the deposit lands. Perps margin is what this terminal trades against. */
export const DEPOSIT_ROUTE = { perps: 0, spot: 1 } as const;
export type DepositRoute = keyof typeof DEPOSIT_ROUTE;

/** The venue rejects direct Ethereum deposits below 1 USDC. */
export const MIN_DEPOSIT_USDC = 1;

/** Every market's minimum order size — deposit at least this much to trade. */
export const MIN_ORDER_USDC = 10;

export const LIGHTER_BRIDGE_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "assetIndex", type: "uint16" },
      { name: "route", type: "uint8" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Cross-chain deposits (Arbitrum, Base, Avalanche) run through Relay + Circle
 * CCTP with per-user intent addresses and a 5 USDC minimum. The endpoint that
 * mints those addresses is not in the public API docs, so this app sends users
 * to the venue for that route rather than guessing at a funds-moving flow.
 */
export const CCTP_CHAINS = ["Arbitrum", "Base", "Avalanche"] as const;
export const MIN_CCTP_DEPOSIT_USDC = 5;
