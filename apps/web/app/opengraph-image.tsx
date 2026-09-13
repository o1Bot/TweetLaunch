import { ImageResponse } from "next/og";
import { C, ChainMark, Frame, gradientText, OG_SIZE, ogOptions } from "@/lib/og";

/** The site's link preview: the pitch, the command, the chains. */

export const runtime = "nodejs";
export const alt = "o1bot.exchange: launch a token on o1 Launchpad from a post on X";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image() {
  const options = await ogOptions();
  return new ImageResponse(
    (
      <Frame footer="Mention @o1bot_exchange on X · your wallet, your creator fees · beta">
        <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ ...gradientText, fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 800, fontSize: 80, lineHeight: 1.04, letterSpacing: -3, display: "flex", flexDirection: "column" }}>
              <div>Launch on o1.</div>
              <div>From a post.</div>
            </div>
            <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 28 }}>
              {(["robinhood", "base", "arc"] as const).map((chain) => (
                <div key={chain} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 24, fontWeight: 500, color: C.ink2 }}>
                  <ChainMark chain={chain} size={30} />
                  {chain === "robinhood" ? "Robinhood Chain" : chain === "base" ? "Base" : "Arc"}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", width: 440, backgroundColor: C.panel, borderRadius: 22, padding: 28, border: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 22, backgroundImage: "linear-gradient(135deg, #F5B54A, #FF7A59)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Bricolage Grotesque, sans-serif", fontWeight: 800, fontSize: 20, color: "#1E1F23" }}>A</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 20, fontWeight: 500, color: C.ink }}>alice</div>
                <div style={{ fontSize: 17, color: C.ink3 }}>@alice · now</div>
              </div>
            </div>
            <div style={{ marginTop: 18, fontSize: 27, lineHeight: 1.35, fontWeight: 500, color: C.ink, display: "flex", flexWrap: "wrap" }}>
              <span style={{ color: C.blue }}>@o1bot_exchange</span>
              <span>&nbsp;launch $CAT &quot;Cash Cat&quot; pair ETH devbuy 0.05 site</span>
            </div>
            <div style={{ marginTop: 18, fontSize: 18, color: C.green, fontWeight: 500 }}>→ token, pool, website. From your wallet.</div>
          </div>
        </div>
      </Frame>
    ),
    options,
  );
}
