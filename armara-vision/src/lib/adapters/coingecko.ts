// CoinGecko adapter — token prices, market caps, volume, supply.
// Free tier by default; set COINGECKO_API_KEY (Pro) to switch base URL and
// raise rate limits automatically.
import { fetchJsonCached } from "./http";
import type { Sourced, TokenMarketAdapter, TokenMarketData } from "./types";

const PRO_KEY = process.env.COINGECKO_API_KEY;
const BASE = PRO_KEY ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
// Free tier is ~10-30 calls/min; stay conservative. Pro: 500/min.
const MIN_INTERVAL_MS = PRO_KEY ? 150 : 2500;
const PRICE_TTL_MS = 60_000; // prices: 60s per NFR
const LIST_TTL_MS = 10 * 60_000;

// CoinGecko's category for tokenized equities.
const TOKENIZED_STOCK_CATEGORY = "tokenized-stock";

function headers(): Record<string, string> {
  return PRO_KEY ? { "x-cg-pro-api-key": PRO_KEY } : {};
}

interface CgMarketRow {
  id: string;
  symbol: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  total_supply: number | null;
  price_change_percentage_24h: number | null;
  last_updated: string | null;
}

function toTokenMarketData(r: CgMarketRow): TokenMarketData {
  return {
    coingeckoId: r.id,
    symbol: r.symbol?.toUpperCase() ?? "",
    priceUsd: r.current_price,
    marketCapUsd: r.market_cap,
    volume24hUsd: r.total_volume,
    totalSupply: r.total_supply,
    change24hPct: r.price_change_percentage_24h,
    lastUpdated: r.last_updated ? new Date(r.last_updated) : null,
  };
}

export const coingecko: TokenMarketAdapter = {
  async getTokenMarkets(ids: string[]): Promise<Sourced<TokenMarketData[]>> {
    if (ids.length === 0) return { data: [], asOf: new Date(), stale: false, provider: "coingecko" };
    const url = `${BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&per_page=250`;
    const hit = await fetchJsonCached<CgMarketRow[]>(url, {
      provider: "coingecko",
      ttlMs: PRICE_TTL_MS,
      minIntervalMs: MIN_INTERVAL_MS,
      headers: headers(),
    });
    return { data: hit.data.map(toTokenMarketData), asOf: hit.asOf, stale: hit.stale, provider: "coingecko" };
  },

  async listTokenizedStocks(): Promise<Sourced<TokenMarketData[]>> {
    const url = `${BASE}/coins/markets?vs_currency=usd&category=${TOKENIZED_STOCK_CATEGORY}&per_page=250&order=market_cap_desc`;
    const hit = await fetchJsonCached<CgMarketRow[]>(url, {
      provider: "coingecko",
      ttlMs: LIST_TTL_MS,
      minIntervalMs: MIN_INTERVAL_MS,
      headers: headers(),
    });
    return { data: hit.data.map(toTokenMarketData), asOf: hit.asOf, stale: hit.stale, provider: "coingecko" };
  },
};

/** Best-effort resolution of a seeded asset's CoinGecko id by token symbol
 *  against the tokenized-stock category (for rows seeded with null ids). */
export async function resolveCoingeckoIdBySymbol(symbol: string): Promise<string | null> {
  try {
    const list = await coingecko.listTokenizedStocks();
    const match = list.data.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
    return match?.coingeckoId ?? null;
  } catch {
    return null;
  }
}
