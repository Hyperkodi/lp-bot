/**
 * Shared types for lp-shadow.
 *
 * Phase 1 is read-only: nothing in this file (or anywhere else in the repo)
 * describes a wallet, a keypair, or a transaction to be signed. A `Decision` is
 * the terminal output of the system.
 */

export type PoolSnapshot = {
  ts: number;
  activeBinId: number;
  /** Quote per base, read off the active bin. */
  activePrice: number;
  binStepBps: number;
  /** Current total fee (base + dynamic), in bps. */
  feeBps: number;
  /** Total liquidity sitting in the active bin, valued in quote units. */
  liqActiveBin: number;
  liqNearby: { binId: number; liquidity: number }[];
  poolTvlUsd?: number;
  poolVol24hUsd?: number;
  poolFees24hUsd?: number;
  /** Pool fees attributed to the interval since the previous snapshot. */
  poolFeesIntervalUsd?: number;
  /** Jupiter cross-check price, when the call succeeded. */
  jupPrice?: number;
};

/**
 * A single bin of the simulated position.
 *
 * DLMM bins hold one asset on each side of the active bin: bins below the
 * active bin are entirely quote, bins above are entirely base, and the active
 * bin holds a mix. Tracking bins individually is what makes impermanent loss
 * fall out of the simulation for free — when the active bin crosses bin `i`,
 * bin `i`'s inventory converts at bin `i`'s own price, not at the market price.
 */
export type VirtualBin = {
  binId: number;
  base: number;
  quote: number;
};

export type VirtualPosition = {
  status: 'ACTIVE' | 'EXITED';
  lowerBinId: number;
  upperBinId: number;
  /** Aggregate virtual holdings inside the position (sum over `bins`). */
  base: number;
  quote: number;
  /** Per-bin inventory; the source of truth that `base`/`quote` summarize. */
  bins: VirtualBin[];
  /** Accrued, not yet compounded. */
  pendingFeesQuote: number;
  cumFeesQuote: number;
  cumCostsQuote: number;
  openedAt: number;
  lastRebalanceAt: number;
  /** When price left the range, else null. */
  oorSince: number | null;
  /** Last price the position was marked at; used to detect bin crossings. */
  lastMarkPrice: number;
  lastMarkBinId: number;
};

export type Signals = {
  /** EWMA half-life ~30 min. */
  volFastAnnual: number;
  /** EWMA half-life ~6 h. */
  volSlowAnnual: number;
  /** Number of returns folded into the EWMAs so far. */
  volSamples: number;
  /** True once `volSamples` clears `volMinSamples` — vol is worth sizing off. */
  volReliable: boolean;
  /** Price within settle_band for settle_min. */
  settled: boolean;
  volTvl24h: number | null;
  volTvlBelowFloorSince: number | null;
  /**
   * Smoothed pool fee APR (fraction per year, not percent) used to project fee
   * recapture in the rebalance cost-coverage gate. Null until the pool stats
   * API has answered at least once.
   */
  poolFeeAprProxy: number | null;
};

export type CostEstimate = {
  /** Execution cost of the hypothetical swap leg, from the Jupiter quote. */
  slippageUsd: number;
  /** Current priority-fee estimate x expected tx count. */
  priorityFeeUsd: number;
  txFeesUsd: number;
  /**
   * Position rent is refundable on close, so it nets to 0. Rent for bin arrays
   * that do not exist yet is sunk — those lamports are never coming back.
   */
  rentDeltaUsd: number;
  totalUsd: number;
};

/**
 * Everything the cost estimator needs, pre-fetched by the poller layer so the
 * decision engine stays pure. Persisted alongside each snapshot so that replay
 * prices decisions with the numbers that were actually live at the time.
 */
export type CostInputs = {
  /** USD notional the hypothetical rebalance swap leg would move. */
  swapNotionalUsd: number;
  /**
   * Value of that leg's output at the reference mid price, in USD. The gap
   * between this and `swapNotionalUsd` is the real execution cost: it folds in
   * price impact and DEX fees together, which is what the Jupiter quote
   * actually tells us. Null when the quote call failed.
   */
  swapOutValueUsd: number | null;
  /** `priceImpactPct` from the quote, as a fraction. Fallback for the above. */
  quotePriceImpactPct: number | null;
  priorityFeeMicroLamportsPerCu: number;
  solPriceUsd: number;
  /** Rent for bin arrays a fresh range would have to create. Sunk, not refundable. */
  newBinArrayRentLamports: number;
};

export type DecisionKind = 'HOLD' | 'COMPOUND' | 'REBALANCE' | 'EXIT';

export type Decision =
  | { kind: 'HOLD'; reasons: string[] }
  | { kind: 'COMPOUND'; feesQuote: number; reasons: string[] }
  | {
      kind: 'REBALANCE';
      newLowerBin: number;
      newUpperBin: number;
      costEst: CostEstimate;
      reasons: string[];
    }
  | { kind: 'EXIT'; costEst: CostEstimate; reasons: string[] };

/**
 * One flat object so the replay harness can sweep any parameter without
 * touching engine code. Mirrors config/default.toml.
 */
export type Params = {
  poolAddress: string;
  poolLabel: string;

  snapshotIntervalSec: number;
  maxConsecutiveFailures: number;
  priceDivergenceAlertPct: number;

  virtualNavUsd: number;
  widthK: number;
  minTotalBins: number;
  maxTotalBins: number;

  minFeesUsd: number;
  minFeesPctNav: number;

  oorDwellMin: number;
  edgeOvershootPct: number;
  settleBandPct: number;
  settleMin: number;
  costCoverageMultiple: number;
  inRangeShareEstimate: number;

  volTvlFloor: number;
  volTvlDwellHours: number;

  volFastHalfLifeMin: number;
  volSlowHalfLifeMin: number;
  volMinSamples: number;

  swapShareOfNav: number;
  quoteSlippageBps: number;
  rebalanceTxCount: number;
  compoundTxCount: number;
  exitTxCount: number;
  computeUnitsPerTx: number;
  signatureFeeLamports: number;

  reportTimezone: string;
  reportDailyHourLocal: number;

  goLiveMinShadowDays: number;
  goLiveRegimeChangeRatio: number;
};

/** Benchmark state, marked on every snapshot (§10). */
export type BenchmarkState = {
  /** t0 basket, held untouched. */
  hodlBase: number;
  hodlQuote: number;
  /** Full-range proxy: V(p) = V0 * sqrt(p / p0), plus credited fees. */
  fullRangeV0: number;
  fullRangeP0: number;
  fullRangeFees: number;
};

export type BenchmarkMarks = {
  hodlNavUsd: number;
  fullRangeUsd: number;
  strategyUsd: number;
};
