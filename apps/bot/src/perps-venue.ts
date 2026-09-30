import {
  DEFAULT_BASE_URL,
  L2_CHAIN_ID,
  TX_TYPE_CREATE_ORDER,
  TX_TYPE_L2_UPDATE_LEVERAGE,
  createLighterClient,
  isSignerError,
  marginFractionFromPercent,
  maxLeverage,
  openWithSecret,
  type BuiltOrder,
  type LighterSignerGlobals,
  type PerpOrderBookDetail,
} from "@o1bot/lighter";
import { liveSigner } from "./perps-register";

/**
 * Everything the perps flow needs from Lighter, behind one interface so the
 * flow runs in tests with a fake: the market behind a symbol, an account's
 * balance and positions, and the signing of a leverage change and an order
 * with the bot's key for that account.
 */

export type PerpMarket = {
  marketId: number;
  symbol: string;
  markPrice: number;
  priceDecimals: number;
  sizeDecimals: number;
  /** The highest whole leverage the venue allows on this market. */
  maxLeverage: number;
  /** Smallest order the venue accepts: in contracts, and in USDC. */
  minBase: number;
  minQuote: number;
};

export type VenuePosition = {
  /** 1 long, -1 short; meaningful only when size is above zero. */
  sign: 1 | -1;
  /** Contracts as the venue's decimal string; "0.00000" for an entry with nothing open. */
  size: string;
  avgEntry: number;
  liquidationPrice: number | null;
  /** The account's leverage for this market as an initial margin fraction in 1e-4; null when the venue gave none. */
  marginFraction: number | null;
  /** 0 cross, 1 isolated. */
  marginMode: number;
};

export type VenueAccount = {
  availableUsdc: number;
  positions: Map<number, VenuePosition>;
};

export type PerpSendInput = {
  accountIndex: number;
  apiKeyIndex: number;
  sealedKey: string;
  /** Set the market's leverage before the order; omitted when it already is what the order wants. */
  leverage?: { marketId: number; fraction: number; marginMode: number };
  order: BuiltOrder;
};

export interface PerpsVenue {
  /** The active perp market with this symbol, or null. */
  market(symbol: string): Promise<PerpMarket | null>;
  account(accountIndex: number): Promise<VenueAccount>;
  send(input: PerpSendInput): Promise<{ leverageTxHash: string | null; orderTxHash: string }>;
}

/** The venue's nil-integrator sentinels and self-trade defaults, the same the terminal signs with. */
const NO_INTEGRATOR = { accountIndex: 0, takerFeePpm: 0, makerFeePpm: 0 } as const;
const SELF_TRADE = { behaviour: 0, equality: 0 } as const;

const MARKETS_TTL_MS = 30_000;

type RawPosition = {
  market_id?: number;
  sign?: number;
  position?: string;
  avg_entry_price?: string;
  liquidation_price?: string;
  initial_margin_fraction?: string;
  margin_mode?: number;
};

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

export function toPerpMarket(d: PerpOrderBookDetail): PerpMarket {
  const raw = d as PerpOrderBookDetail & { min_base_amount?: string; min_quote_amount?: string; last_trade_price?: number };
  return {
    marketId: d.market_id,
    symbol: d.symbol,
    markPrice: num(d.mark_price) || num(raw.last_trade_price),
    priceDecimals: d.supported_price_decimals,
    sizeDecimals: d.supported_size_decimals,
    maxLeverage: Math.floor(maxLeverage(d)),
    minBase: num(raw.min_base_amount),
    minQuote: num(raw.min_quote_amount),
  };
}

export function toVenuePosition(p: RawPosition): VenuePosition {
  const liq = num(p.liquidation_price);
  return {
    sign: p.sign === -1 ? -1 : 1,
    size: p.position ?? "0",
    avgEntry: num(p.avg_entry_price),
    liquidationPrice: liq > 0 ? liq : null,
    marginFraction: marginFractionFromPercent(p.initial_margin_fraction),
    marginMode: p.margin_mode === 1 ? 1 : 0,
  };
}

export function livePerpsVenue(opts: { vaultKey: string; signer?: () => Promise<LighterSignerGlobals> }): PerpsVenue {
  const client = createLighterClient();
  const signer = opts.signer ?? liveSigner;
  let markets: { at: number; bySymbol: Map<string, PerpMarket> } | null = null;

  async function loadMarkets(): Promise<Map<string, PerpMarket>> {
    if (markets && Date.now() - markets.at < MARKETS_TTL_MS) return markets.bySymbol;
    const res = await client.orderBookDetails();
    const bySymbol = new Map<string, PerpMarket>();
    for (const d of res.order_book_details) {
      // Delisted markets are still returned; only an active one can take an order.
      if ((d as { status?: string }).status !== "active") continue;
      bySymbol.set(d.symbol.toUpperCase(), toPerpMarket(d));
    }
    markets = { at: Date.now(), bySymbol };
    return bySymbol;
  }

  return {
    async market(symbol) {
      const all = await loadMarkets();
      const hit = all.get(symbol.toUpperCase());
      if (!hit) return null;
      // The cached mark can be half a minute old; an order's price guard needs the current one.
      const fresh = await client.orderBookDetails();
      const d = fresh.order_book_details.find((x) => x.market_id === hit.marketId);
      return d ? toPerpMarket(d) : hit;
    },

    async account(accountIndex) {
      const res = await client.accountByIndex(accountIndex);
      const a = (res as { accounts?: Array<{ available_balance?: string; positions?: RawPosition[] }> } | null)?.accounts?.[0];
      if (!a) throw new Error(`Lighter has no account ${accountIndex}`);
      const positions = new Map<number, VenuePosition>();
      for (const p of a.positions ?? []) if (typeof p.market_id === "number") positions.set(p.market_id, toVenuePosition(p));
      return { availableUsdc: num(a.available_balance), positions };
    },

    async send({ accountIndex, apiKeyIndex, sealedKey, leverage, order }) {
      const privateKey = await openWithSecret(sealedKey, opts.vaultKey);
      const s = await signer();
      const created = s.CreateClient(DEFAULT_BASE_URL, privateKey, L2_CHAIN_ID, apiKeyIndex, accountIndex);
      if (isSignerError(created)) throw new Error(`could not create a signing client: ${created.error}`);

      let { nonce } = await client.nextNonce(accountIndex, apiKeyIndex);
      let leverageTxHash: string | null = null;
      if (leverage) {
        const tx = s.SignUpdateLeverage(leverage.marketId, leverage.fraction, leverage.marginMode, 0, nonce, apiKeyIndex, accountIndex);
        if (isSignerError(tx)) throw new Error(`could not sign the leverage change: ${tx.error}`);
        if (tx.txType !== TX_TYPE_L2_UPDATE_LEVERAGE) throw new Error(`signer produced tx type ${tx.txType}, expected a leverage change (${TX_TYPE_L2_UPDATE_LEVERAGE})`);
        await client.sendTx(tx.txType, tx.txInfo);
        leverageTxHash = tx.txHash;
        nonce += 1;
      }

      const tx = s.SignCreateOrder(
        order.marketIndex,
        // The venue dedupes on this, so two orders from one account must not share it.
        Date.now(),
        order.baseAmount,
        order.price,
        order.isAsk,
        order.orderType,
        order.timeInForce,
        order.reduceOnly,
        order.triggerPrice,
        order.orderExpiry,
        NO_INTEGRATOR.accountIndex,
        NO_INTEGRATOR.takerFeePpm,
        NO_INTEGRATOR.makerFeePpm,
        SELF_TRADE.behaviour,
        SELF_TRADE.equality,
        0,
        nonce,
        apiKeyIndex,
        accountIndex,
      );
      if (isSignerError(tx)) throw new Error(`could not sign the order: ${tx.error}`);
      if (tx.txType !== TX_TYPE_CREATE_ORDER) throw new Error(`signer produced tx type ${tx.txType}, expected an order (${TX_TYPE_CREATE_ORDER})`);
      await client.sendTx(tx.txType, tx.txInfo);
      return { leverageTxHash, orderTxHash: tx.txHash };
    },
  };
}
