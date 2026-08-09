// DefiLlama adapter — protocol TVL for issuers (Ondo, Backed, Dinari,
// Securitize). Public API, no key.
import { fetchJsonCached } from "./http";
import type { ProtocolTvl, Sourced, TvlAdapter } from "./types";

const BASE = "https://api.llama.fi";
const TTL_MS = 10 * 60_000;
const MIN_INTERVAL_MS = 500;

interface LlamaProtocol {
  tvl: { date: number; totalLiquidityUSD: number }[] | number;
  currentChainTvls?: Record<string, number>;
}

export const defillama: TvlAdapter = {
  async getProtocolTvl(slug: string): Promise<Sourced<ProtocolTvl>> {
    const url = `${BASE}/protocol/${slug}`;
    const hit = await fetchJsonCached<LlamaProtocol>(url, {
      provider: "defillama",
      ttlMs: TTL_MS,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    const p = hit.data;
    let tvlUsd: number | null = null;
    if (typeof p.tvl === "number") tvlUsd = p.tvl;
    else if (Array.isArray(p.tvl) && p.tvl.length > 0) tvlUsd = p.tvl[p.tvl.length - 1].totalLiquidityUSD;
    return {
      data: { slug, tvlUsd, chainTvls: p.currentChainTvls ?? {} },
      asOf: hit.asOf,
      stale: hit.stale,
      provider: "defillama",
    };
  },
};
