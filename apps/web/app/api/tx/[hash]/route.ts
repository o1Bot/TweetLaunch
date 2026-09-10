import { isHex } from "viem";
import { publicClient } from "@o1bot/shared";
import { isChainKey } from "@/lib/chains-web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tx/:hash — receipt status for a transaction the browser sent. */
export async function GET(req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isHex(hash) || hash.length !== 66) return Response.json({ error: "bad hash" }, { status: 400 });
  const chainParam = new URL(req.url).searchParams.get("chain");
  const chain = isChainKey(chainParam) ? chainParam : "robinhood";
  try {
    const receipt = await publicClient(chain).getTransactionReceipt({ hash });
    return Response.json({ status: receipt.status, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  } catch {
    return Response.json({ status: "pending" });
  }
}
