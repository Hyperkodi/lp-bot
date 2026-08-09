// Adapter contracts. Every external data source implements one of these so
// providers stay swappable (e.g. Finnhub -> Polygon for equities, or adding
// a CoinGecko Pro key) without touching metrics or UI code.

export interface TokenMarketData {
  coingeckoId: string;
  symbol: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  totalSupply: number | null;
  change24hPct: number | null;
  lastUpdated: Date | null;
}

export interface PoolData {
  poolAddress: string;
  network: string; // GeckoTerminal network slug
  dexName: string | null;
  baseTokenSymbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
}

export interface EquityQuote {
  ticker: string;
  priceUsd: number | null;
  previousClose: number | null;
  changePct: number | null;
  quotedAt: Date | null;
}

export interface ProtocolTvl {
  slug: string;
  tvlUsd: number | null;
  chainTvls: Record<string, number>;
}

/** Result wrapper: every adapter response carries provenance so the UI can
 *  always render an "as of" timestamp and a degraded-data indicator. */
export interface Sourced<T> {
  data: T;
  asOf: Date;
  stale: boolean;
  provider: string;
}

export interface TokenMarketAdapter {
  /** Batch quote by CoinGecko id (or provider equivalent). */
  getTokenMarkets(ids: string[]): Promise<Sourced<TokenMarketData[]>>;
  /** All tokens in the provider's tokenized-stock category — used to
   *  auto-discover ids for seeded assets and to detect new listings. */
  listTokenizedStocks(): Promise<Sourced<TokenMarketData[]>>;
}

export interface DexAdapter {
  /** Top pools for a token on a network. */
  getTokenPools(network: string, tokenAddress: string): Promise<Sourced<PoolData[]>>;
  /** Search pools by token symbol when we don't yet know the address. */
  searchPools(query: string, network?: string): Promise<Sourced<PoolData[]>>;
}

export interface EquityPriceAdapter {
  getQuote(ticker: string): Promise<Sourced<EquityQuote>>;
}

export interface TvlAdapter {
  getProtocolTvl(slug: string): Promise<Sourced<ProtocolTvl>>;
}
