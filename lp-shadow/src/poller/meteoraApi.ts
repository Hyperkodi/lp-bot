/**
 * Pool-level stats (TVL, 24h volume, 24h fees) from Meteora's public DLMM data
 * API.
 *
 * Verified 2026-08 against @meteora-ag/dlmm 1.9.14-era docs:
 *   base   https://dlmm.datapi.meteora.ag   (rate limit 30 rps)
 *   GET    /pools/{address}
 *   fields tvl, current_price, volume.24h, fees.24h,
 *          cumulative_metrics.{volume,trade_fee,protocol_fee},
 *          pool_config.{bin_step,base_fee_pct,max_fee_pct,protocol_fee_pct}
 *
 * This base URL has migrated before (the older host was dlmm-api.meteora.ag),
 * so it is overridable with METEORA_API_BASE rather than baked in.
 */
import { fetchJson } from './http.js';

const DEFAULT_BASE = 'https://dlmm.datapi.meteora.ag';

type TimeBuckets = Partial<Record<'30m' | '1h' | '2h' | '4h' | '12h' | '24h', number>>;

type PoolResponse = {
  address: string;
  name?: string;
  tvl?: number;
  current_price?: number;
  apr?: number;
  volume?: TimeBuckets;
  fees?: TimeBuckets;
  pool_config?: { bin_step?: number; base_fee_pct?: number; max_fee_pct?: number };
  cumulative_metrics?: { volume?: number; trade_fee?: number; protocol_fee?: number };
};

export type PoolStats = {
  tvlUsd?: number;
  vol24hUsd?: number;
  fees24hUsd?: number;
  apiPrice?: number;
  /** Lifetime cumulative trade fees, USD. Drives the per-interval fee delta. */
  cumulativeTradeFeeUsd?: number;
  binStepBps?: number;
};

export function meteoraApiBase(): string {
  return process.env.METEORA_API_BASE ?? DEFAULT_BASE;
}

export async function fetchPoolStats(poolAddress: string): Promise<PoolStats> {
  const url = `${meteoraApiBase()}/pools/${poolAddress}`;
  const body = await fetchJson<PoolResponse>(url, { timeoutMs: 10_000 });
  return {
    tvlUsd: body.tvl,
    vol24hUsd: body.volume?.['24h'],
    fees24hUsd: body.fees?.['24h'],
    apiPrice: body.current_price,
    cumulativeTradeFeeUsd: body.cumulative_metrics?.trade_fee,
    binStepBps: body.pool_config?.bin_step,
  };
}

/**
 * Pool fees attributable to the interval since the previous snapshot.
 *
 * Preferred source is the delta of the pool's lifetime cumulative trade fees,
 * because that is an actual counter. When the cursor is missing or the counter
 * went backwards (an API reset, or a pool that dropped out of the index), fall
 * back to pro-rating the 24h figure over the elapsed interval. Both are
 * approximations of a per-bin fee-growth read; §9 says so out loud.
 */
export function intervalFeesUsd(
  stats: PoolStats,
  previousCumulativeFeeUsd: number | null,
  elapsedSec: number,
): { feesUsd: number | undefined; source: 'cumulative-delta' | 'prorated-24h' | 'none' } {
  const cumulative = stats.cumulativeTradeFeeUsd;
  if (
    cumulative !== undefined &&
    previousCumulativeFeeUsd !== null &&
    cumulative >= previousCumulativeFeeUsd
  ) {
    return { feesUsd: cumulative - previousCumulativeFeeUsd, source: 'cumulative-delta' };
  }
  if (stats.fees24hUsd !== undefined && elapsedSec > 0) {
    return { feesUsd: stats.fees24hUsd * (elapsedSec / 86_400), source: 'prorated-24h' };
  }
  return { feesUsd: undefined, source: 'none' };
}
