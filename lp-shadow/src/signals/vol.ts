/**
 * EWMA realized volatility. Pure: every function returns new state.
 *
 * Snapshots arrive on a roughly fixed interval but ticks get skipped whenever
 * an RPC call fails, so spacing is treated as irregular throughout. Each return
 * contributes a variance *rate* (r^2 / dt) rather than a raw squared return,
 * and the decay factor is derived from the actual elapsed time — a 90-second
 * gap decays twice as much as a 45-second one.
 */

export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export type VolState = {
  /** Variance per second. Null until the second observation arrives. */
  varRate: number | null;
  samples: number;
  lastTs: number | null;
  lastPrice: number | null;
};

export function initVolState(): VolState {
  return { varRate: null, samples: 0, lastTs: null, lastPrice: null };
}

/**
 * Folds one (ts, price) observation into the EWMA.
 *
 * `halfLifeSec` is the time over which an observation's weight halves.
 */
export function updateVol(
  state: VolState,
  ts: number,
  price: number,
  halfLifeSec: number,
): VolState {
  if (!(price > 0)) return state;
  if (state.lastTs === null || state.lastPrice === null) {
    return { varRate: state.varRate, samples: state.samples, lastTs: ts, lastPrice: price };
  }

  const dtSec = (ts - state.lastTs) / 1000;
  if (dtSec <= 0) return state;

  const logReturn = Math.log(price / state.lastPrice);
  const observedVarRate = (logReturn * logReturn) / dtSec;
  const alpha = 1 - Math.exp((-dtSec * Math.LN2) / halfLifeSec);
  const varRate =
    state.varRate === null
      ? observedVarRate
      : alpha * observedVarRate + (1 - alpha) * state.varRate;

  return { varRate, samples: state.samples + 1, lastTs: ts, lastPrice: price };
}

/** Annualized volatility as a fraction (0.65 = 65% annualized). */
export function annualizedVol(state: VolState): number {
  if (state.varRate === null || state.varRate < 0) return 0;
  return Math.sqrt(state.varRate * SECONDS_PER_YEAR);
}

export type VolTracker = {
  fast: VolState;
  slow: VolState;
};

export function initVolTracker(): VolTracker {
  return { fast: initVolState(), slow: initVolState() };
}

export function updateVolTracker(
  tracker: VolTracker,
  ts: number,
  price: number,
  fastHalfLifeMin: number,
  slowHalfLifeMin: number,
): VolTracker {
  return {
    fast: updateVol(tracker.fast, ts, price, fastHalfLifeMin * 60),
    slow: updateVol(tracker.slow, ts, price, slowHalfLifeMin * 60),
  };
}
