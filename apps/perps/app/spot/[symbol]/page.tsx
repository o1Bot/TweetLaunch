import { MarketDetail } from "@/components/MarketDetail";

export const revalidate = 60;

export default async function SpotPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <MarketDetail symbol={symbol} type="spot" />;
}
