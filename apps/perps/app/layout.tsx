import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const metadataBase = new URL(
  (process.env.PERPS_SITE_URL?.trim() || "https://perps.o1bot.exchange").replace(/\/$/, ""),
);

export const metadata: Metadata = {
  metadataBase,
  title: "o1bot perps — trade 240+ markets on Lighter",
  description:
    "Perps and spot on Lighter: stocks, gold, oil, treasuries, FX and pre-IPO. o1bot builds and routes the order; Lighter matches and settles.",
  openGraph: {
    title: "o1bot perps",
    description:
      "Perps and spot on Lighter: stocks, gold, oil, treasuries, FX and pre-IPO. o1bot builds and routes the order; Lighter matches and settles.",
    siteName: "o1bot perps",
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
      <body>{children}</body>
    </html>
  );
}
