import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DataStatus } from "@/components/DataStatus";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { Providers } from "./providers";
import "./globals.css";
import "./market.css";

/** Absolute base for the preview images and other metadata URLs; the deployment's SITE_URL, else the public site. */
const metadataBase = new URL((process.env.SITE_URL?.trim() || "https://o1bot.exchange").replace(/\/$/, ""));

// The preview image itself comes from app/opengraph-image.tsx (and, per token, app/token/[address]/opengraph-image.tsx).
export const metadata: Metadata = {
  metadataBase,
  title: "o1bot.exchange — launch on o1 from a post",
  description: "Mention @o1bot_exchange on X to launch a token on o1 Launchpad. Your wallet, your creator fees.",
  openGraph: {
    title: "o1bot.exchange",
    description: "Mention @o1bot_exchange on X to launch a token on o1 Launchpad. Your wallet, your creator fees.",
    siteName: "o1bot.exchange",
    type: "website",
  },
  twitter: { card: "summary_large_image", site: "@o1bot_exchange" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,100,300..700&family=Sora:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <SiteHeader />
          <DataStatus />
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
