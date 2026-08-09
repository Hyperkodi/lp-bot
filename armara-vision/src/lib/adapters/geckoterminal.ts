// GeckoTerminal adapter — on-chain DEX data: pools, liquidity, volume.
// Public API, no key required; ~30 calls/min. Networks of interest:
// solana, eth, bsc, arbitrum, base.
import { fetchJsonCached } from "./http";
import type { DexAdapter, PoolData, Sourced } from "./types";

const BASE = "https://api.geckoterminal.com/api/v2";
const MIN_INTERVAL_MS = 2100; // ~28/min, under the 30/min public cap
const POOL_TTL_MS = 60_000;

interface GtPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    reserve_in_usd: string | null;
    volume_usd: { h24: string | null };
  };
  relationships?: {
    dex?: { data?: { id?: string } };
  };
}

function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toPoolData(p: GtPool, network: string): PoolData {
  return {
    poolAddress: p.attributes.address,
    network,
    dexName: p.relationships?.dex?.data?.id ?? null,
    baseTokenSymbol: p.attributes.name?.split("/")[0]?.trim() ?? null,
    priceUsd: num(p.attributes.base_token_price_usd),
    liquidityUsd: num(p.attributes.reserve_in_usd),
    volume24hUsd: num(p.attributes.volume_usd?.h24),
  };
}

export const geckoterminal: DexAdapter = {
  async getTokenPools(network: string, tokenAddress: string): Promise<Sourced<PoolData[]>> {
    const url = `${BASE}/networks/${network}/tokens/${tokenAddress}/pools?page=1`;
    const hit = await fetchJsonCached<{ data: GtPool[] }>(url, {
      provider: "geckoterminal",
      ttlMs: POOL_TTL_MS,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    return { data: (hit.data.data ?? []).map((p) => toPoolData(p, network)), asOf: hit.asOf, stale: hit.stale, provider: "geckoterminal" };
  },

  async searchPools(query: string, network?: string): Promise<Sourced<PoolData[]>> {
    const url = `${BASE}/search/pools?query=${encodeURIComponent(query)}${network ? `&network=${network}` : ""}`;
    const hit = await fetchJsonCached<{ data: GtPool[] }>(url, {
      provider: "geckoterminal",
      ttlMs: POOL_TTL_MS,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    const net = network ?? "unknown";
    return { data: (hit.data.data ?? []).map((p) => toPoolData(p, net)), asOf: hit.asOf, stale: hit.stale, provider: "geckoterminal" };
  },
};
