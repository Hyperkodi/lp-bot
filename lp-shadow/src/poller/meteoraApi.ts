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
  created_at?: number;
  tvl?: number;
  current_price?: number;
  apr?: number;
  volume?: TimeBuckets;
  fees?: TimeBuckets;
  pool_config?: { bin_step?: number; base_fee_pct?: number; max_fee_pct?: number };
  cumulative_metrics?: { volume?: number; fees?: number; trade_fee?: number; protocol_fee?: number };
  token_x?: { address?: string; symbol?: string; decimals?: number };
  token_y?: { address?: string; symbol?: string; decimals?: number };
};

export type PoolStats = {
  /** Pair name as the API reports it, e.g. "SOL-USDC". */
  name?: string;
  tvlUsd?: number;
  vol24hUsd?: number;
  fees24hUsd?: number;
  apiPrice?: number;
  /** Lifetime cumulative trade fees, USD. Drives the per-interval fee delta. */
  cumulativeTradeFeeUsd?: number;
  binStepBps?: number;
  createdAtMs?: number;
  baseFeePct?: number;
  baseMint?: string;
  baseSymbol?: string;
  baseDecimals?: number;
  quoteMint?: string;
  quoteSymbol?: string;
  quoteDecimals?: number;
};

export function meteoraApiBase(): string {
  return process.env.METEORA_API_BASE ?? DEFAULT_BASE;
}

export async function fetchPoolStats(poolAddress: string): Promise<PoolStats> {
  const url = `${meteoraApiBase()}/pools/${poolAddress}`;
  const body = await fetchJson<PoolResponse>(url, { timeoutMs: 10_000 });
  return {
    name: body.name,
    tvlUsd: body.tvl,
    vol24hUsd: body.volume?.['24h'],
    fees24hUsd: body.fees?.['24h'],
    apiPrice: body.current_price,
    cumulativeTradeFeeUsd: body.cumulative_metrics?.trade_fee ?? body.cumulative_metrics?.fees,
    binStepBps: body.pool_config?.bin_step,
    createdAtMs: body.created_at,
    baseFeePct: body.pool_config?.base_fee_pct,
    baseMint: body.token_x?.address,
    baseSymbol: body.token_x?.symbol,
    baseDecimals: body.token_x?.decimals,
    quoteMint: body.token_y?.address,
    quoteSymbol: body.token_y?.symbol,
    quoteDecimals: body.token_y?.decimals,
  };
}

export type OhlcvTimeframe = '5m' | '30m' | '1h' | '2h' | '4h' | '12h' | '24h';
export type OhlcvCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type OhlcvResponse = { data?: OhlcvCandle[] };

function usableCandle(value: OhlcvCandle): boolean {
  return (
    Number.isInteger(value.timestamp) &&
    value.timestamp >= 0 &&
    [value.open, value.high, value.low, value.close].every(
      (number) => Number.isFinite(number) && number > 0,
    ) &&
    Number.isFinite(value.volume) &&
    value.volume >= 0 &&
    value.high >= Math.max(value.open, value.close) &&
    value.low <= Math.min(value.open, value.close)
  );
}

/** Fetch and strictly validate one bounded OHLCV window. */
export async function fetchPoolOhlcv(
  poolAddress: string,
  timeframe: OhlcvTimeframe,
  startTimeSec: number,
  endTimeSec: number,
): Promise<OhlcvCandle[]> {
  if (!Number.isInteger(startTimeSec) || !Number.isInteger(endTimeSec) || endTimeSec < startTimeSec) {
    throw new Error('Meteora OHLCV range must use ordered integer Unix seconds');
  }
  const params = new URLSearchParams({
    timeframe,
    start_time: String(startTimeSec),
    end_time: String(endTimeSec),
  });
  const body = await fetchJson<OhlcvResponse>(
    `${meteoraApiBase()}/pools/${poolAddress}/ohlcv?${params}`,
    { timeoutMs: 15_000 },
  );
  if (!Array.isArray(body.data)) throw new Error('Meteora OHLCV response has no data array');
  if (!body.data.every(usableCandle)) throw new Error('Meteora OHLCV response contains an unusable candle');
  return [...body.data].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Meteora caps OHLCV ranges near 100 candles, so longer windows are fetched in
 * non-overlapping chunks and de-duplicated by timestamp.
 */
export async function fetchPoolOhlcvRange(
  poolAddress: string,
  timeframe: OhlcvTimeframe,
  startTimeSec: number,
  endTimeSec: number,
): Promise<OhlcvCandle[]> {
  const seconds: Record<OhlcvTimeframe, number> = {
    '5m': 300,
    '30m': 1_800,
    '1h': 3_600,
    '2h': 7_200,
    '4h': 14_400,
    '12h': 43_200,
    '24h': 86_400,
  };
  const step = seconds[timeframe];
  const byTimestamp = new Map<number, OhlcvCandle>();
  for (let cursor = startTimeSec; cursor <= endTimeSec; cursor += step * 99) {
    const chunkEnd = Math.min(endTimeSec, cursor + step * 98);
    const chunk = await fetchPoolOhlcv(poolAddress, timeframe, cursor, chunkEnd);
    for (const candle of chunk) byTimestamp.set(candle.timestamp, candle);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
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
