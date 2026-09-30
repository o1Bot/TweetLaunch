"use client";

import {
  MIN_WITHDRAW_USDC,
  SECURE_WITHDRAW_MINUTES,
  WithdrawError,
  buildWithdraw,
  createLighterClient,
  formatUsdcUnits,
} from "@o1bot/lighter";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { useMemo, useState } from "react";
import { useAccount } from "@/components/AccountContext";
import { usdExact } from "@/lib/format";
import { NoKeyError } from "@/lib/submit";
import { submitWithdraw } from "@/lib/withdraw";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The largest amount the venue would accept, as a string the input can hold exactly. */
function maxAmount(available: number): string {
  return formatUsdcUnits(BigInt(Math.floor(available * 1_000_000)));
}

/**
 * Withdraw collateral to the wallet that owns the account, by the secure
 * route. It sits under the deposit on purpose: the two are the same money
 * moving in opposite directions, and someone who put it in here expects to
 * take it out here rather than be sent to the venue's site for the way back.
 */
export function Withdraw({ wallet, onWithdrawn }: { wallet: ConnectedWallet; onWithdrawn: () => void }) {
  const { accountIndex, availableBalance, hasKey, refresh } = useAccount();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; amount: string } | null>(null);

  // One build feeds the button and the submission: the amount shown as
  // leaving is the amount signed.
  const built = useMemo(() => {
    if (!amount.trim() || availableBalance === null) return null;
    try {
      return buildWithdraw({ amountUsdc: amount, availableUsdc: availableBalance });
    } catch (e) {
      return e instanceof WithdrawError ? e.message : null;
    }
  }, [amount, availableBalance]);
  const ok = typeof built === "object" && built !== null ? built : null;

  async function withdraw() {
    if (!ok || accountIndex === null || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const provider = await wallet.getEthereumProvider();
      const signMessage = (message: string) =>
        provider.request({ method: "personal_sign", params: [message, wallet.address] }) as Promise<string>;

      const { txHash } = await submitWithdraw({
        client: createLighterClient(),
        accountIndex,
        built: ok,
        signMessage,
      });
      setDone({ hash: txHash, amount: ok.amountUsdc });
      setAmount("");
      refresh();
      onWithdrawn();
    } catch (e) {
      setError(
        e instanceof NoKeyError
          ? "No signing key on this device — register one above first."
          : e instanceof Error
            ? e.message
            : "withdrawal failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="deposit withdraw">
      <p>
        Available to withdraw:{" "}
        <strong>{availableBalance === null ? "—" : usdExact(availableBalance)}</strong>
      </p>

      <div className="linkrow">
        <input
          className="chip amt"
          inputMode="decimal"
          placeholder={`Amount (min ${MIN_WITHDRAW_USDC})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Withdraw amount in USDC"
        />
        <button
          type="button"
          className="chip"
          onClick={() => availableBalance !== null && setAmount(maxAmount(availableBalance))}
          disabled={availableBalance === null || availableBalance < MIN_WITHDRAW_USDC}
        >
          Max
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void withdraw()}
          disabled={busy || !ok || !hasKey}
        >
          {busy ? "Signing…" : "Withdraw"}
        </button>
      </div>

      {typeof built === "string" && <p className="down">{built}</p>}
      {!hasKey && (
        <p className="fine">A withdrawal is signed with the key registered above, so register one first.</p>
      )}
      {done && (
        <p className="up">
          Withdrawal of {done.amount} USDC sent · {done.hash.slice(0, 12)}…
        </p>
      )}
      {error && <p className="down">{error}</p>}

      <p className="fine">
        Secure route: the venue pays out to {short(wallet.address)} on Ethereum — the address that
        owns the account, and the only place a Lighter withdrawal can go — in about{" "}
        {SECURE_WITHDRAW_MINUTES} minutes. No venue fee. Your wallet signs once, to unlock the
        trading key on this device; the withdrawal itself is signed with that key. Margin backing an
        open position stays put until the position closes.
      </p>
    </div>
  );
}
