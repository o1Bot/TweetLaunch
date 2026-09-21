import { NextResponse } from "next/server";
import { lookupAccount } from "@/lib/account";
import { lighter } from "@/lib/lighter";

/** Loose check only — the venue is the authority on whether an address exists. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether an L1 address already has a Lighter account. Read-only: it tells the
 * link step what to offer, and never touches a key.
 */
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }

  const status = await lookupAccount(lighter, address);
  // An account appearing, or collateral changing, must not be served stale.
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
