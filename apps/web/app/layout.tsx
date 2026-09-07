import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { Providers } from "./providers";
import "./globals.css";
import "./market.css";

export const metadata: Metadata = {
  title: "o1bot.exchange — launch on o1 from a post",
  description: "Mention @o1bot_exchange on X to launch a token on o1 Launchpad. Your wallet, your creator fees.",
  openGraph: {
    title: "o1bot.exchange",
    description: "Mention @o1bot_exchange on X to launch a token on o1 Launchpad. Your wallet, your creator fees.",
    images: ["/logo.png"],
  },
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
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
