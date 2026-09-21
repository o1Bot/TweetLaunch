"use client";

import Link from "next/link";
import { useAccount } from "@/components/AccountContext";
import { usdExact } from "@/lib/format";

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Equity and unrealised PnL are summed from the account stream rather than
 * shown from a stored figure, so they move with the positions below them.
 * Before the venue answers they read "—": an account that has not loaded is not
 * an account worth zero, and a trader reading zero equity would act on it.
 */
export function TopBar() {
  const { ready, authenticated, login, address, accountIndex, state, collateral, availableBalance } =
    useAccount();

  const positions = state?.positions() ?? [];
  const unrealized = positions.reduce((sum, p) => sum + Number(p.unrealized_pnl || 0), 0);
  const hasAccount = accountIndex !== null;
  const equity = hasAccount && collateral !== null ? collateral + unrealized : null;

  return (
    <header className="top">
      <Link className="brand" href="/">
        <img src="/mark.png" alt="" width={24} height={24} />
        o1bot <em>perps</em>
      </Link>

      <div className="grow" />

      <div className="acct">
        <div className="kv">
          <span>Equity</span>
          <b>{equity === null ? "—" : usdExact(equity)}</b>
        </div>
        <div className="kv">
          <span>Available</span>
          <b>{availableBalance === null ? "—" : usdExact(availableBalance)}</b>
        </div>
        <div className="kv">
          <span>Unrealised</span>
          <b className={!hasAccount ? "" : unrealized > 0 ? "up" : unrealized < 0 ? "down" : ""}>
            {!hasAccount ? "—" : `${unrealized >= 0 ? "+" : "-"}${usdExact(Math.abs(unrealized))}`}
          </b>
        </div>

        <Link className="chip" href="/start">
          {hasAccount ? "Deposit" : "Set up"}
        </Link>

        {!ready ? null : authenticated && address ? (
          <span className="addr">{short(address)}</span>
        ) : (
          <button type="button" className="btn" onClick={login}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
