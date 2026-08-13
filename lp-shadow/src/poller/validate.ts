/**
 * The gate between the network and everything that trusts its numbers.
 *
 * A poll that *throws* is already handled: the tick is skipped and no snapshot
 * is fabricated. A poll that *succeeds with nonsense* is the dangerous case —
 * an RPC returning NaN, Infinity, zero or a negative price raises nothing, and
 * the value flows into the vol EWMAs (which are exponentially weighted, so one
 * non-finite sample poisons them permanently), into the decision engine, and
 * into a ledger whose numeric columns accept NaN without complaint.
 *
 * So bad data is rejected here, at the boundary, and reported as a poll
 * failure — which the loop already knows how to survive and alert on.
 */
import type { PoolSnapshot } from '../types.js';

export class BadSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadSnapshotError';
  }
}

function requireFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new BadSnapshotError(`pool returned a non-finite ${field}: ${value}`);
  }
}

function requirePositive(value: number, field: string): void {
  requireFinite(value, field);
  if (value <= 0) {
    throw new BadSnapshotError(`pool returned a non-positive ${field}: ${value}`);
  }
}

function requireNonNegative(value: number, field: string): void {
  requireFinite(value, field);
  if (value < 0) {
    throw new BadSnapshotError(`pool returned a negative ${field}: ${value}`);
  }
}

/**
 * Throws `BadSnapshotError` unless every number the strategy depends on is
 * usable. Optional fields are checked only when present — the pool stats API
 * being unavailable is a normal condition, a stats API reporting NaN is not.
 */
export function assertUsableSnapshot(snapshot: PoolSnapshot): void {
  requirePositive(snapshot.activePrice, 'activePrice');
  requirePositive(snapshot.binStepBps, 'binStepBps');
  requireNonNegative(snapshot.feeBps, 'feeBps');
  requireNonNegative(snapshot.liqActiveBin, 'liqActiveBin');

  if (!Number.isInteger(snapshot.activeBinId)) {
    throw new BadSnapshotError(`pool returned a non-integer activeBinId: ${snapshot.activeBinId}`);
  }

  for (const bin of snapshot.liqNearby) {
    if (!Number.isInteger(bin.binId)) {
      throw new BadSnapshotError(`pool returned a non-integer nearby binId: ${bin.binId}`);
    }
    requireNonNegative(bin.liquidity, `liquidity for bin ${bin.binId}`);
  }

  const optional: [number | undefined, string][] = [
    [snapshot.poolTvlUsd, 'poolTvlUsd'],
    [snapshot.poolVol24hUsd, 'poolVol24hUsd'],
    [snapshot.poolFees24hUsd, 'poolFees24hUsd'],
    [snapshot.poolFeesIntervalUsd, 'poolFeesIntervalUsd'],
  ];
  for (const [value, field] of optional) {
    if (value !== undefined) requireNonNegative(value, field);
  }
  if (snapshot.jupPrice !== undefined) requirePositive(snapshot.jupPrice, 'jupPrice');
}
