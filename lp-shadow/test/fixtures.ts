/**
 * Fixture builders for the engine tests. Every fixture is explicit — no
 * randomness, no clock reads — so a failing test names one behaviour.
 */
import { loadRawConfig, toParams } from '../src/config.js';
import type {
  CostInputs,
  Params,
  PoolSnapshot,
  Signals,
  VirtualPosition,
} from '../src/types.js';
import { openPosition } from '../src/virtual/position.js';

export const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** The shipped config, so the tests exercise the parameters that will actually run. */
export const baseParams: Params = toParams(loadRawConfig('config/default.toml'), 70);

export function params(overrides: Partial<Params> = {}): Params {
  return { ...baseParams, ...overrides };
}

export function snapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    ts: T0,
    activeBinId: 1000,
    activePrice: 150,
    binStepBps: 20,
    feeBps: 20,
    liqActiveBin: 250_000,
    liqNearby: [],
    poolTvlUsd: 10_000_000,
    poolVol24hUsd: 40_000_000,
    poolFees24hUsd: 20_000,
    poolFeesIntervalUsd: 10,
    ...overrides,
  };
}

export function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    volFastAnnual: 0.6,
    volSlowAnnual: 0.6,
    volSamples: 500,
    volReliable: true,
    settled: true,
    volTvl24h: 4,
    volTvlBelowFloorSince: null,
    // 0.073 = 20k fees / 10M TVL * 365, i.e. the fixture pool's own APR.
    poolFeeAprProxy: 0.73,
    ...overrides,
  };
}

export function costInputs(overrides: Partial<CostInputs> = {}): CostInputs {
  return {
    swapNotionalUsd: 5_000,
    swapOutValueUsd: 4_997,
    quotePriceImpactPct: 0.0006,
    priorityFeeMicroLamportsPerCu: 20_000,
    solPriceUsd: 150,
    newBinArrayRentLamports: 0,
    ...overrides,
  };
}

export function position(overrides: Partial<VirtualPosition> = {}): VirtualPosition {
  const base = openPosition(snapshot(), 985, 1015, 10_000);
  return { ...base, ...overrides };
}
