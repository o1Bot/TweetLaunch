"use client";

import {
  DEPOSIT_ROUTE,
  ERC20_ABI,
  LIGHTER_BRIDGE_ABI,
  LIGHTER_BRIDGE_ADDRESS,
  MIN_DEPOSIT_USDC,
  MIN_ORDER_USDC,
  USDC_ADDRESS,
  USDC_ASSET_ID,
  USDC_DECIMALS,
} from "@o1bot/lighter";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

/**
 * Depositing creates the Lighter account, so this step works before one exists
 * — which is the whole reason it is here rather than a link to the venue.
 *
 * Only the direct Ethereum route is offered. It is one approve plus one call
 * with a selector and arguments this repo has verified. The cross-chain route
 * is cheaper for the user but mints a per-user intent address through an
 * endpoint the venue does not document, and guessing at a flow that moves
 * someone's money is not a trade worth making.
 */
export function Deposit({ wallet, onDeposited }: { wallet: ConnectedWallet; onDeposited: () => void }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<null | "approving" | "depositing">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const address = wallet.address as Address;

  const clients = useCallback(async () => {
    const provider = await wallet.getEthereumProvider();
    const transport = custom(provider);
    return {
      // Reads go through the wallet's own RPC: it is already pointed at the
      // chain the deposit lands on, so there is no second endpoint to configure
      // or to disagree with it.
      pub: createPublicClient({ chain: mainnet, transport }),
      wal: createWalletClient({ account: address, chain: mainnet, transport }),
    };
  }, [wallet, address]);

  const refresh = useCallback(async () => {
    try {
      const { pub } = await clients();
      setBalance(
        await pub.readContract({
          address: USDC_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }),
      );
    } catch {
      setBalance(null);
    }
  }, [clients, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const parsed = (() => {
    try {
      return amount.trim() ? parseUnits(amount.trim(), USDC_DECIMALS) : 0n;
    } catch {
      return 0n;
    }
  })();

  const minRaw = parseUnits(String(MIN_DEPOSIT_USDC), USDC_DECIMALS);
  const tooSmall = parsed > 0n && parsed < minRaw;
  const tooBig = balance !== null && parsed > balance;

  async function deposit() {
    if (busy || parsed <= 0n || tooSmall || tooBig) return;
    setError(null);
    setDone(null);
    try {
      const { pub, wal } = await clients();

      // The venue's bridge lives on Ethereum mainnet; a wallet pointed anywhere
      // else would otherwise send a real transaction to an address that means
      // something different there.
      await wallet.switchChain(mainnet.id);

      const allowance = await pub.readContract({
        address: USDC_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, LIGHTER_BRIDGE_ADDRESS as Address],
      });

      if (allowance < parsed) {
        setBusy("approving");
        // Approve exactly what is being deposited rather than an unlimited
        // allowance: this contract keeps no standing claim on the balance.
        const hash = await wal.writeContract({
          address: USDC_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [LIGHTER_BRIDGE_ADDRESS as Address, parsed],
        });
        await pub.waitForTransactionReceipt({ hash });
      }

      setBusy("depositing");
      const hash = await wal.writeContract({
        address: LIGHTER_BRIDGE_ADDRESS as Address,
        abi: LIGHTER_BRIDGE_ABI,
        functionName: "deposit",
        args: [address, USDC_ASSET_ID, DEPOSIT_ROUTE.perps, parsed],
        value: 0n,
      });
      await pub.waitForTransactionReceipt({ hash });

      setDone(hash);
      setAmount("");
      await refresh();
      onDeposited();
    } catch (e) {
      setError(e instanceof Error ? e.message : "deposit failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="deposit">
      <p>
        USDC on Ethereum:{" "}
        <strong>{balance === null ? "—" : formatUnits(balance, USDC_DECIMALS)}</strong>
      </p>

      <div className="linkrow">
        <input
          className="chip amt"
          inputMode="decimal"
          placeholder={`Amount (min ${MIN_DEPOSIT_USDC})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Deposit amount in USDC"
        />
        <button
          type="button"
          className="btn"
          onClick={() => void deposit()}
          disabled={busy !== null || parsed <= 0n || tooSmall || tooBig}
        >
          {busy === "approving" ? "Approving…" : busy === "depositing" ? "Depositing…" : "Deposit"}
        </button>
      </div>

      {tooSmall && <p className="down">The venue rejects deposits below {MIN_DEPOSIT_USDC} USDC.</p>}
      {tooBig && <p className="down">That is more than this wallet holds.</p>}

      <p className="fine">
        Two transactions on Ethereum mainnet, so budget for gas: an approve for exactly this amount,
        then the deposit. Every market needs at least {MIN_ORDER_USDC} USDC of margin to place an
        order, so depositing the {MIN_DEPOSIT_USDC} USDC minimum lets the account exist without
        being able to trade yet.
      </p>

      {done && (
        <p className="up">
          Deposited. The account appears once the venue credits the bridge, which is not instant —
          re-check in a minute if it is not there yet.
        </p>
      )}
      {error && <p className="down">Deposit failed: {error}</p>}
    </div>
  );
}
