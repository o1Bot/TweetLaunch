/**
 * Inline logos for the chains and base assets the profile shows, so nothing
 * depends on a third-party image host. Simplified marks, brand colours.
 */

type P = { size?: number; className?: string };

export function EthIcon({ size = 20, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <path d="M16.5 4v8.87l7.5 3.35L16.5 4z" fill="#fff" fillOpacity=".6" />
      <path d="M16.5 4 9 16.22l7.5-3.35V4z" fill="#fff" />
      <path d="M16.5 21.97V28l7.5-10.38-7.5 4.35z" fill="#fff" fillOpacity=".6" />
      <path d="M16.5 28v-6.03L9 17.62 16.5 28z" fill="#fff" />
      <path d="m16.5 20.57 7.5-4.35-7.5-3.34v7.69z" fill="#fff" fillOpacity=".2" />
      <path d="m9 16.22 7.5 4.35v-7.69L9 16.22z" fill="#fff" fillOpacity=".6" />
    </svg>
  );
}

export function BaseIcon({ size = 20, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#0052FF" />
      <circle cx="16" cy="16" r="10.5" fill="#fff" />
      <rect x="0" y="15.05" width="19.5" height="1.9" fill="#0052FF" />
    </svg>
  );
}

export function ArbitrumIcon({ size = 20, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#2D374B" />
      <path d="M16 6 7 11.2v9.6L16 26l9-5.2v-9.6L16 6z" fill="none" stroke="#96BEDC" strokeWidth="1.6" />
      <path d="m13.2 20.4 4.3-9.6 1.5 1.1-3.9 8.8-1.9-.3z" fill="#28A0F0" />
      <path d="m10.6 20.8 6.1-12.9 1.9-.1-6.6 13.7-1.4-.7z" fill="#28A0F0" fillOpacity=".7" />
      <path d="m17.8 20.7 3.1-6.9 1.2 2.3-2.6 5.3-1.7-.7z" fill="#28A0F0" />
    </svg>
  );
}

export function OptimismIcon({ size = 20, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#FF0420" />
      <text x="16" y="20.2" textAnchor="middle" fontFamily="Sora, system-ui, sans-serif" fontWeight="800" fontSize="11.5" fill="#fff">
        OP
      </text>
    </svg>
  );
}

/** Robinhood's own mark (black feather on lime), served from /public so it stays pixel-faithful. */
export function RobinhoodIcon({ size = 20, className }: P) {
  return <img src="/chains/robinhood.png" width={size} height={size} alt="" className={className} style={{ borderRadius: "50%", display: "block" }} aria-hidden="true" />;
}

export function UsdgIcon({ size = 20, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#0E8F6F" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="#fff" strokeWidth="1.6" />
      <text x="16" y="20.6" textAnchor="middle" fontFamily="Sora, system-ui, sans-serif" fontWeight="800" fontSize="12.5" fill="#fff">
        $
      </text>
    </svg>
  );
}

export function StockIcon({ size = 20, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#6B4FD8" />
      <path d="M8 21.5 13.5 15l4 4L24 11" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 11H24v4.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Display names for the chains the profile shows, keyed like the API rows. */
export const CHAIN_NAMES: Record<string, string> = { robinhood: "Robinhood", base: "Base", ethereum: "Ethereum", arbitrum: "Arbitrum", optimism: "Optimism" };

/** The chain's mark by its key, for badges and the gas card. */
export function ChainIcon({ chain, size = 20, className }: { chain: string } & P) {
  switch (chain) {
    case "robinhood":
      return <RobinhoodIcon size={size} className={className} />;
    case "base":
      return <BaseIcon size={size} className={className} />;
    case "ethereum":
      return <EthIcon size={size} className={className} />;
    case "arbitrum":
      return <ArbitrumIcon size={size} className={className} />;
    case "optimism":
      return <OptimismIcon size={size} className={className} />;
    default:
      return null;
  }
}

/** The mark for a base asset by symbol: ETH, USDG, or a stock token. */
export function AssetIcon({ symbol, kind, size = 20, className }: { symbol: string; kind: "native" | "quote" | "token" } & P) {
  if (kind === "native" || symbol.toUpperCase() === "ETH" || symbol.toUpperCase() === "WETH") return <EthIcon size={size} className={className} />;
  if (symbol.toUpperCase() === "USDG") return <UsdgIcon size={size} className={className} />;
  return <StockIcon size={size} className={className} />;
}
