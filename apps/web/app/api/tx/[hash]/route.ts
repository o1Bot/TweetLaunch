import { isHex } from "viem";
import { publicClient } from "@o1bot/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tx/:hash — receipt status for a transaction the browser sent. */
export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isHex(hash) || hash.length !== 66) return Response.json({ error: "bad hash" }, { status: 400 });
  try {
    const receipt = await publicClient("robinhood").getTransactionReceipt({ hash });
    return Response.json({ status: receipt.status, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  } catch {
    return Response.json({ status: "pending" });
  }
}
