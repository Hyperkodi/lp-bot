/**
 * Benchmarks (§10). Both are seeded at t0 with the same `virtual_nav_usd` as
 * the strategy so the three equity curves start on the same line.
 *
 * PURE: state in, state out.
 */
import type { BenchmarkMarks, BenchmarkState, PoolSnapshot, VirtualPosition } from '../types.js';
import { positionValueQuote } from './position.js';

/**
 * HODL is the t0 token basket, held untouched. This is the bar to beat — if the
 * strategy cannot clear it net of costs, the strategy is not worth running.
 *
 * The full-range proxy is a v2-style constant-product LP: V(p) = V0 * sqrt(p/p0).
 */
export function initBenchmarks(
  snapshot: PoolSnapshot,
  navUsd: number,
  hodlBaseShare = 0.5,
): BenchmarkState {
  if (!Number.isFinite(hodlBaseShare) || hodlBaseShare < 0 || hodlBaseShare > 1) {
    throw new Error('HODL base share must be between zero and one');
  }
  const price = snapshot.activePrice;
  return {
    hodlBase: price > 0 ? (navUsd * hodlBaseShare) / price : 0,
    hodlQuote: navUsd * (1 - hodlBaseShare),
    fullRangeV0: navUsd,
    fullRangeP0: price,
    fullRangeFees: 0,
  };
}

/**
 * Credits the full-range proxy its share of the interval's pool fees.
 *
 * Deliberately crude, and labeled as such everywhere it is reported: it treats
 * the proxy as if it held `V/TVL` of the pool, which over-credits a full-range
 * position in a concentrated pool. It exists to answer one question — is
 * concentration adding anything? — not to be accurate.
 */
export function creditFullRangeFees(
  state: BenchmarkState,
  snapshot: PoolSnapshot,
): BenchmarkState {
  const intervalFees = snapshot.poolFeesIntervalUsd ?? 0;
  const tvl = snapshot.poolTvlUsd ?? 0;
  if (intervalFees <= 0 || !(tvl > 0)) return state;

  const value = fullRangeValue(state, snapshot.activePrice);
  const share = Math.min(1, value / tvl);
  return { ...state, fullRangeFees: state.fullRangeFees + share * intervalFees };
}

export function hodlValue(state: BenchmarkState, price: number): number {
  return state.hodlBase * price + state.hodlQuote;
}

export function fullRangeValue(state: BenchmarkState, price: number): number {
  if (!(state.fullRangeP0 > 0) || !(price > 0)) return state.fullRangeV0;
  return state.fullRangeV0 * Math.sqrt(price / state.fullRangeP0);
}

export function markBenchmarks(
  state: BenchmarkState,
  position: VirtualPosition,
  snapshot: PoolSnapshot,
): BenchmarkMarks {
  const price = snapshot.activePrice;
  return {
    hodlNavUsd: hodlValue(state, price),
    fullRangeUsd: fullRangeValue(state, price) + state.fullRangeFees,
    strategyUsd: positionValueQuote(position, price) + position.pendingFeesQuote,
  };
}
