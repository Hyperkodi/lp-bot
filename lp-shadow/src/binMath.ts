/**
 * Bin arithmetic shared by the decision engine and the virtual position.
 *
 * Pure and synchronous: no clock, no network, no I/O imports. DLMM bins are
 * geometric, so every price here is derived from the active bin's price and the
 * bin step rather than from token decimals — that keeps the whole pure layer
 * free of on-chain types.
 */
import type { Params, PoolSnapshot, Signals } from './types.js';

export const DAYS_PER_YEAR = 365;

/** Price of `binId`, given the price of the currently active bin. */
export function binPrice(
  binId: number,
  activeBinId: number,
  activePrice: number,
  binStepBps: number,
): number {
  return activePrice * Math.pow(1 + binStepBps / 10_000, binId - activeBinId);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export type RangePlan = {
  lowerBinId: number;
  upperBinId: number;
  binsPerSide: number;
  /** Half-width actually targeted, as a fraction of price. */
  halfWidthPct: number;
  /** Half-width the vol signal asked for, before clamping to the bin limits. */
  requestedHalfWidthPct: number;
};

/**
 * Range width rule (§8).
 *
 * Slow vol sets the width — fast vol is for the `settled` flag and regime
 * detection only. Widen-in-chop and narrow-in-quiet fall out of this without
 * any extra rule.
 */
export function planRange(
  activeBinId: number,
  binStepBps: number,
  signals: Signals,
  params: Params,
): RangePlan {
  const sigmaDaily = signals.volSlowAnnual / Math.sqrt(DAYS_PER_YEAR);
  const requestedHalfWidthPct = params.widthK * sigmaDaily;
  const binStepFrac = binStepBps / 10_000;

  // min_total_bins/2 rounds up and max_total_bins/2 rounds down so that the
  // resulting total bin count honours both bounds.
  const minPerSide = Math.ceil(params.minTotalBins / 2);
  const maxPerSide = Math.floor(params.maxTotalBins / 2);
  const binsPerSide = clamp(
    Math.round(requestedHalfWidthPct / binStepFrac),
    minPerSide,
    maxPerSide,
  );

  return {
    lowerBinId: activeBinId - binsPerSide,
    upperBinId: activeBinId + binsPerSide,
    binsPerSide,
    halfWidthPct: binsPerSide * binStepFrac,
    requestedHalfWidthPct,
  };
}

export function isInRange(
  snapshot: Pick<PoolSnapshot, 'activeBinId'>,
  lowerBinId: number,
  upperBinId: number,
): boolean {
  return snapshot.activeBinId >= lowerBinId && snapshot.activeBinId <= upperBinId;
}

/**
 * How far price has run past the nearest edge of the range, as a fraction of
 * that edge's price. Zero when price is still inside.
 */
export function edgeOvershoot(
  snapshot: PoolSnapshot,
  lowerBinId: number,
  upperBinId: number,
): number {
  if (isInRange(snapshot, lowerBinId, upperBinId)) return 0;
  const edgeBinId = snapshot.activeBinId > upperBinId ? upperBinId : lowerBinId;
  const edgePrice = binPrice(
    edgeBinId,
    snapshot.activeBinId,
    snapshot.activePrice,
    snapshot.binStepBps,
  );
  if (edgePrice <= 0) return 0;
  return Math.abs(snapshot.activePrice - edgePrice) / edgePrice;
}
