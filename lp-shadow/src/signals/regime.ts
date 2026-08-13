/**
 * Regime signals: the `settled` flag, volume/TVL health, and the smoothed pool
 * fee APR the rebalance cost-coverage gate projects from.
 *
 * Pure: all state is threaded in and out. The only "clock" is the timestamp
 * carried on each snapshot.
 */
import { DAYS_PER_YEAR } from '../binMath.js';
import type { Params, PoolSnapshot, Signals } from '../types.js';
import { annualizedVol, initVolTracker, updateVolTracker, type VolTracker } from './vol.js';

const MS_PER_MIN = 60_000;

export type RegimeState = {
  vol: VolTracker;
  /** Recent (ts, price) points, trimmed to the settle window. */
  priceWindow: { ts: number; price: number }[];
  volTvlBelowFloorSince: number | null;
  /** EWMA of pool fee APR (fraction per year). */
  feeAprEwma: number | null;
};

export function initRegimeState(): RegimeState {
  return {
    vol: initVolTracker(),
    priceWindow: [],
    volTvlBelowFloorSince: null,
    feeAprEwma: null,
  };
}

/**
 * "Settled" means price has stayed inside a `settleBandPct` band for at least
 * `settleMin` minutes — the guard against rebalancing into a trend (§8 gate d).
 *
 * The window must actually span `settleMin` minutes of observations; a freshly
 * booted process with two ticks in it is not settled, it is uninformed.
 */
export function isSettled(
  window: { ts: number; price: number }[],
  now: number,
  params: Params,
): boolean {
  if (params.settleMin <= 0) return true;
  const cutoff = now - params.settleMin * MS_PER_MIN;
  const points = window.filter((p) => p.ts >= cutoff);
  if (points.length < 2) return false;
  const oldest = points[0]!;
  if (oldest.ts > cutoff) return false;

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.price < min) min = p.price;
    if (p.price > max) max = p.price;
  }
  const mid = (min + max) / 2;
  if (!(mid > 0)) return false;
  // Full band width, so "+/- settle_band_pct" is the band the price stayed in.
  return ((max - min) / mid) * 100 <= params.settleBandPct * 2;
}

/**
 * Pool fee APR proxy: fees24h / TVL, annualized, then EWMA-smoothed across
 * snapshots so a single quiet or frantic day cannot swing the rebalance gate.
 */
export function feeAprFromSnapshot(snapshot: PoolSnapshot): number | null {
  const { poolFees24hUsd, poolTvlUsd } = snapshot;
  if (poolFees24hUsd === undefined || poolTvlUsd === undefined || !(poolTvlUsd > 0)) {
    return null;
  }
  return (poolFees24hUsd / poolTvlUsd) * DAYS_PER_YEAR;
}

export function volTvlFromSnapshot(snapshot: PoolSnapshot): number | null {
  const { poolVol24hUsd, poolTvlUsd } = snapshot;
  if (poolVol24hUsd === undefined || poolTvlUsd === undefined || !(poolTvlUsd > 0)) {
    return null;
  }
  return poolVol24hUsd / poolTvlUsd;
}

/**
 * Folds a snapshot into the regime state and derives the `Signals` the engine
 * consumes. The fee-APR EWMA uses a fixed half-life of one hour of snapshots;
 * it only needs to be slow enough to ignore per-tick jitter.
 */
export function updateRegime(
  state: RegimeState,
  snapshot: PoolSnapshot,
  params: Params,
): { state: RegimeState; signals: Signals } {
  const vol = updateVolTracker(
    state.vol,
    snapshot.ts,
    snapshot.activePrice,
    params.volFastHalfLifeMin,
    params.volSlowHalfLifeMin,
  );

  const windowCutoff = snapshot.ts - Math.max(params.settleMin, 1) * MS_PER_MIN * 2;
  const priceWindow = [...state.priceWindow, { ts: snapshot.ts, price: snapshot.activePrice }]
    .filter((p) => p.ts >= windowCutoff)
    .sort((a, b) => a.ts - b.ts);

  const volTvl24h = volTvlFromSnapshot(snapshot);
  let volTvlBelowFloorSince = state.volTvlBelowFloorSince;
  if (volTvl24h === null) {
    // Unknown is not "below floor" — never start an exit clock on missing data.
  } else if (volTvl24h < params.volTvlFloor) {
    volTvlBelowFloorSince ??= snapshot.ts;
  } else {
    volTvlBelowFloorSince = null;
  }

  const feeApr = feeAprFromSnapshot(snapshot);
  let feeAprEwma = state.feeAprEwma;
  if (feeApr !== null) {
    const alpha = 1 - Math.exp((-params.snapshotIntervalSec * Math.LN2) / 3600);
    feeAprEwma = feeAprEwma === null ? feeApr : alpha * feeApr + (1 - alpha) * feeAprEwma;
  }

  const nextState: RegimeState = {
    vol,
    priceWindow,
    volTvlBelowFloorSince,
    feeAprEwma,
  };

  const signals: Signals = {
    volFastAnnual: annualizedVol(vol.fast),
    volSlowAnnual: annualizedVol(vol.slow),
    volSamples: vol.slow.samples,
    volReliable: vol.slow.samples >= params.volMinSamples,
    settled: isSettled(priceWindow, snapshot.ts, params),
    volTvl24h,
    volTvlBelowFloorSince,
    poolFeeAprProxy: feeAprEwma,
  };

  return { state: nextState, signals };
}
