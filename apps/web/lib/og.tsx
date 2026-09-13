import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactNode } from "react";
import type { ChainKey } from "./chains-web";

/**
 * Shared pieces of the link preview images (Open Graph / X cards) rendered
 * with next/og: brand colours, the fonts, the chain marks and the frame
 * every card sits in. Satori rules apply inside: every box with more than
 * one child is a flex container, and only inline styles exist.
 */

export const OG_SIZE = { width: 1200, height: 630 };

export const C = {
  bg: "#1E1F23",
  panel: "#26272C",
  panel2: "#303136",
  line: "#3A3C44",
  ink: "#EAF0F8",
  ink2: "#A6B3C4",
  ink3: "#6E7C8F",
  blue: "#6FB6FF",
  blueBtn: "#2F7BFF",
  green: "#3ED082",
  red: "#FF6B6B",
};

/** Gradient headline text, as on the site. */
export const gradientText = {
  backgroundImage: "linear-gradient(100deg, #FFFFFF 0%, #DDEBFF 45%, #7FBFFF 100%)",
  backgroundClip: "text",
  color: "transparent",
} as const;

/** Where the deployment serves its own static files from; the cards reference the marks by URL. */
export function siteBase(): string {
  const raw = process.env.SITE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://o1bot.exchange";
  return raw.replace(/\/$/, "");
}

type FontFile = { name: string; data: Buffer; weight: 500 | 800; style: "normal" };
let fontsPromise: Promise<FontFile[]> | null = null;

/**
 * The site's body family, Bricolage Grotesque, in Medium and ExtraBold from
 * assets/fonts (static TrueType, read once per process). The renderer takes
 * no variable fonts and cannot load WOFF2, so the files are bundled rather
 * than fetched from Google at request time. Bundling also keeps the image
 * identical on every deployment. A missing file leaves the renderer's own
 * default sans in place of that weight.
 */
export function ogFonts(): Promise<FontFile[]> {
  // Literal paths, so the deployment's file tracing ships the files with the image routes.
  const files: Array<[FontFile["weight"], string]> = [
    [500, join(process.cwd(), "assets/fonts/bricolage-500.ttf")],
    [800, join(process.cwd(), "assets/fonts/bricolage-800.ttf")],
  ];
  fontsPromise ??= Promise.all(
    files.map(async ([weight, path]): Promise<FontFile | null> => {
      try {
        return { name: "Bricolage Grotesque", data: await readFile(path), weight, style: "normal" };
      } catch {
        return null;
      }
    }),
  ).then((list) => list.filter((f): f is FontFile => f !== null));
  return fontsPromise;
}

/** Options for ImageResponse: the size and the fonts, when any loaded (an empty list would leave the renderer with none). */
export async function ogOptions(): Promise<{ width: number; height: number; fonts?: FontFile[] }> {
  const fonts = await ogFonts();
  return fonts.length ? { ...OG_SIZE, fonts } : { ...OG_SIZE };
}

/** A remote image as a data URL so the renderer never waits on a slow gateway; null when it cannot be fetched in time. */
export async function inlineImage(url: string | null, timeoutMs = 4000): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
    if (!type.startsWith("image/") || type === "image/svg+xml") return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export const CHAIN_NAME: Record<ChainKey, string> = { robinhood: "Robinhood Chain", base: "Base", arc: "Arc" };

/** A chain's round mark at `size` pixels. */
export function ChainMark({ chain, size }: { chain: ChainKey; size: number }) {
  if (chain === "base") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="16" fill="#0052FF" />
        <circle cx="16" cy="16" r="10.5" fill="#fff" />
        <rect x="0" y="15.05" width="19.5" height="1.9" fill="#0052FF" />
      </svg>
    );
  }
  const src = `${siteBase()}/chains/${chain === "robinhood" ? "robinhood.png" : "arc.jpg"}`;
  return <img src={src} width={size} height={size} style={{ width: size, height: size, borderRadius: size / 2 }} />;
}

/** The dark frame with the brand in the top left and a footer line; `children` fills the middle. */
export function Frame({ children, footer }: { children: ReactNode; footer: string }) {
  return (
    <div
      style={{
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.bg,
        backgroundImage: "radial-gradient(circle at 85% 15%, rgba(47,123,255,0.22) 0%, rgba(47,123,255,0) 55%)",
        color: C.ink,
        fontFamily: "Bricolage Grotesque, sans-serif",
        fontWeight: 500,
        padding: "48px 64px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <img src={`${siteBase()}/mark.png`} width={44} height={44} style={{ width: 44, height: 44 }} />
        <div style={{ fontWeight: 800, fontSize: 30, letterSpacing: -0.5 }}>o1bot.exchange</div>
      </div>
      <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "center" }}>{children}</div>
      <div style={{ display: "flex", fontSize: 24, color: C.ink3 }}>{footer}</div>
    </div>
  );
}
