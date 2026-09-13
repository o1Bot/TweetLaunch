import { ImageResponse } from "next/og";
import { formatPct, formatPrice, formatUsd } from "@o1bot/market";
import { C, CHAIN_NAME, ChainMark, Frame, gradientText, inlineImage, OG_SIZE, ogOptions } from "@/lib/og";
import { getTokenDetail } from "@/lib/market";

/** A token page's link preview: logo, name, chain, the live figures, the creator. */

export const runtime = "nodejs";
export const revalidate = 300;
export const alt = "Token launched from a post through o1bot";
export const size = OG_SIZE;
export const contentType = "image/png";

function Stat({ label, value, note, noteColor }: { label: string; value: string; note?: string; noteColor?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, backgroundColor: C.panel, borderRadius: 18, padding: "18px 22px", border: `1px solid ${C.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 19, fontWeight: 500 }}>
        <div style={{ color: C.ink3 }}>{label}</div>
        {note ? <div style={{ color: noteColor ?? C.ink2 }}>{note}</div> : null}
      </div>
      <div style={{ marginTop: 6, fontWeight: 800, fontSize: 34, color: C.ink, letterSpacing: -1 }}>{value}</div>
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const [options, t] = await Promise.all([ogOptions(), getTokenDetail(address).catch(() => null)]);
  if (!t) {
    return new ImageResponse(
      (
        <Frame footer="o1bot.exchange">
          <div style={{ ...gradientText, fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 800, fontSize: 72, letterSpacing: -2 }}>Token not found</div>
        </Frame>
      ),
      options,
    );
  }
  const logo = await inlineImage(t.imageUrl);
  const money = (n: number | null, quote: number | null) => (n !== null ? formatUsd(n) : formatPrice(quote, t.quoteSymbol));
  const change = t.stats.change24hPct;
  const creator = t.creator.xHandle ? `@${t.creator.xHandle}` : `${t.creator.wallet.slice(0, 6)}…${t.creator.wallet.slice(-4)}`;
  return new ImageResponse(
    (
      <Frame footer={`Launched from a post by ${creator} · o1bot.exchange/token/${t.token.slice(0, 6)}…${t.token.slice(-4)}`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
            {logo ? (
              <img src={logo} width={150} height={150} style={{ width: 150, height: 150, borderRadius: 32, objectFit: "cover" }} />
            ) : (
              <div style={{ width: 150, height: 150, borderRadius: 32, backgroundColor: C.panel2, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 800, fontSize: 64, color: C.blue }}>
                {t.symbol.slice(0, 1)}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
              <div style={{ ...gradientText, fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 800, fontSize: 64, letterSpacing: -2, lineHeight: 1.05 }}>{t.name.length > 26 ? `${t.name.slice(0, 25)}…` : t.name}</div>
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 14, fontSize: 27, fontWeight: 500, color: C.ink2 }}>
                <div style={{ color: C.ink, fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 800 }}>{`$${t.symbol}`}</div>
                <div>·</div>
                <div>{`${t.quoteSymbol} pool`}</div>
                <div>·</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ChainMark chain={t.chain} size={26} />
                  {CHAIN_NAME[t.chain]}
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <Stat label="Price" value={t.stats.priceUsd !== null ? formatUsd(t.stats.priceUsd) : formatPrice(t.stats.priceQuote, t.quoteSymbol)} note={change === null ? undefined : formatPct(change)} noteColor={change === null ? undefined : change >= 0 ? C.green : C.red} />
            <Stat label="Market cap" value={money(t.stats.mcapUsd, t.stats.mcapQuote)} />
            <Stat label="24h volume" value={money(t.stats.volume24hUsd, t.stats.volume24hQuote)} />
            <Stat label="Trades" value={t.tradeCount.toLocaleString("en-US")} />
          </div>
        </div>
      </Frame>
    ),
    options,
  );
}
