/**
 * Decode a live o1 launch transaction on Robinhood Chain: the call, the
 * LaunchParams, the dev-buy route steps, and every event in the receipt.
 * Used to check the bot's encoding against launches made through o1's UI.
 *
 *   pnpm decode-launch 0x<tx hash>
 */
import "@o1bot/shared/load-env";
import { decodeAbiParameters, decodeFunctionData, formatEther, formatUnits, getAddress, parseAbi, parseEventLogs, type Hex } from "viem";
import { allQuotes, logsClient, o1Chain } from "@o1bot/shared";
import { launchFactoryAbi, launchHookAbi } from "../src/abis";
import { ROUTE_STEPS_ABI } from "../src/route";

const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

function label(address: string): string {
  const chain = o1Chain("robinhood");
  const known: Record<string, string> = {
    [chain.contracts.factory!]: "o1 factory",
    [chain.contracts.hook!]: "o1 hook",
    [chain.contracts.launchBuyAdapter!]: "o1 launch-buy adapter",
    [chain.uniswapV4.poolManager]: "v4 PoolManager",
    [String(chain.swapX.wrappedNativeToken)]: "WETH",
  };
  const a = getAddress(address);
  const quote = allQuotes("robinhood").find((q) => q.address === a);
  return known[a] ?? (quote ? `${quote.symbol} (${quote.kind})` : a);
}

async function main() {
  const hash = process.argv[2] as Hex | undefined;
  if (!hash?.startsWith("0x")) throw new Error("usage: pnpm decode-launch 0x<tx hash>");
  const client = logsClient("robinhood");
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });

  console.log("from      ", tx.from);
  console.log("to        ", tx.to, tx.to ? `(${label(tx.to)})` : "");
  console.log("value     ", formatEther(tx.value), "ETH");
  console.log("status    ", receipt.status, "| gas used", receipt.gasUsed.toString(), "| block", receipt.blockNumber.toString(), new Date(Number(block.timestamp) * 1000).toISOString());

  const decoded = decodeFunctionData({ abi: launchFactoryAbi, data: tx.input });
  console.log("function  ", decoded.functionName);
  if (decoded.functionName !== "createLaunch" && decoded.functionName !== "createLaunchAndBuy") return;
  const params = decoded.args[0];
  console.log("params    ", {
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    tokenContractURI: params.tokenContractURI,
    creatorSalt: params.creatorSalt,
    quoteToken: `${params.quoteToken} (${label(params.quoteToken)})`,
    expectedConfigVersion: params.expectedConfigVersion.toString(),
    deadline: `${params.deadline.toString()} (${(params.deadline - block.timestamp).toString()} s after the block)`,
    metadataEditable: params.metadataEditable,
    metadataKeys: params.metadataKeys,
  });

  if (decoded.functionName === "createLaunchAndBuy") {
    const buy = decoded.args[1];
    console.log("buy       ", { fundingToken: buy.fundingToken, amountIn: `${formatEther(buy.amountIn)} ETH`, minAmountOut: buy.minAmountOut.toString(), routeBytes: (buy.routeData.length - 2) / 2 });
    const [steps] = decodeAbiParameters(ROUTE_STEPS_ABI, buy.routeData);
    steps.forEach((s, i) => {
      console.log(`  step ${i}  `, {
        kind: s.kind === 1 ? "V3" : s.kind === 2 ? "V4" : s.kind,
        tokenIn: label(s.tokenIn),
        tokenOut: label(s.tokenOut),
        pool: s.pool,
        fee: s.fee,
        tickSpacing: s.tickSpacing,
        hooks: s.hooks === "0x0000000000000000000000000000000000000000" ? "none" : label(s.hooks),
        hookData: s.hookData,
      });
    });
  }

  for (const l of parseEventLogs({ abi: launchFactoryAbi, eventName: "Launched", logs: receipt.logs })) {
    console.log("Launched  ", { token: l.args.token, poolId: l.args.poolId, creator: l.args.originalCreator, quote: label(l.args.quoteToken) });
  }
  for (const s of parseEventLogs({ abi: poolManagerAbi, logs: receipt.logs })) {
    console.log("Swap      ", { id: s.args.id, sender: label(s.args.sender), amount0: s.args.amount0.toString(), amount1: s.args.amount1.toString(), fee: s.args.fee });
  }
  for (const t of parseEventLogs({ abi: launchHookAbi, eventName: "Trade", logs: receipt.logs })) {
    console.log("Trade     ", { poolId: t.args.poolId, executor: label(t.args.executor), referrer: t.args.referrer, feeCurrency: label(t.args.feeCurrency), totalFee: t.args.totalFeeAmount.toString() });
  }
  for (const t of parseEventLogs({ abi: erc20Abi, logs: receipt.logs })) {
    const quote = allQuotes("robinhood").find((q) => q.address === getAddress(t.address));
    console.log("Transfer  ", { token: label(t.address), from: label(t.args.from), to: label(t.args.to), value: quote ? formatUnits(t.args.value, quote.decimals) : t.args.value.toString() });
  }
  console.log("emitters  ", [...new Set(receipt.logs.map((l) => label(l.address)))].join(" | "));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
