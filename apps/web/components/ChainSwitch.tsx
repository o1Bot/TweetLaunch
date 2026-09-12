"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BOARD_CHAINS, CHAIN_COOKIE, CHAIN_SHORT, isChainKey, type ChainKey } from "@/lib/chains-web";
import { ChainIcon } from "./ChainIcons";

/**
 * Robinhood / Base switch in the header. Picking a chain remembers it in a
 * cookie (so the board keeps it next visit) and opens the board for it.
 * Robinhood is the default and needs no query string.
 */
export function ChainSwitch({ current }: { current: ChainKey }) {
  const router = useRouter();
  const [active, setActive] = useState<ChainKey>(current);

  // A shared link like /?chain=base wins over the cookie the server rendered from.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("chain");
      if (isChainKey(q)) setActive(q);
    } catch {
      // ignore
    }
  }, []);

  const choose = (key: ChainKey) => {
    setActive(key);
    try {
      document.cookie = `${CHAIN_COOKIE}=${key}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      // ignore
    }
    router.push(key === "robinhood" ? "/" : `/?chain=${key}`);
  };

  return (
    <div className="chainsw" role="group" aria-label="Chain">
      {BOARD_CHAINS.map((key) => (
        <button key={key} type="button" className={key === active ? "on" : ""} aria-pressed={key === active} onClick={() => choose(key)} title={`Show launches on ${CHAIN_SHORT[key]}`}>
          <ChainIcon chain={key} size={16} />
          <span>{CHAIN_SHORT[key]}</span>
        </button>
      ))}
    </div>
  );
}
