import type { Metadata } from "next";
import { SiteEditor } from "@/components/SiteEditor";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Edit ${slug} — o1bot.exchange`, description: "Change the look and the copy of your token's site, preview it, publish it.", robots: { index: false } };
}

export default async function SitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="wrap se-page">
      <SiteEditor slug={slug} />
    </main>
  );
}
