/**
 * The virtual position: a simulated DLMM position that is marked, accrues fees,
 * compounds, rebalances and exits exactly as the strategy says it should — and
 * touches nothing on chain.
 *
 * PURE: every function takes state and returns new state. No clock, no network,
 * no imports from poller/ledger/report.
 */
import { binPrice, isInRange } from '../binMath.js';
import type {
  CostEstimate,
  Params,
  PoolSnapshot,
  VirtualBin,
  VirtualPosition,
} from '../types.js';

/**
 * Spot distribution: the same token amount in every bin on each side, which is
 * what `calculateSpotDistribution` in the DLMM SDK builds (uniform
 * `xAmountBpsOfTotal` above the active bin, uniform `yAmountBpsOfTotal` below).
 * It is expressed here in plain amounts so the pure layer stays free of BN and
 * on-chain types; test/engine.test.ts cross-checks it against the SDK helper.
 *
 * Bins below the active bin hold quote only, bins above hold base only, and the
 * active bin is split down the middle. Because the base deposited into a high
 * bin is bought at *today's* price, equal token amounts per bin also means
 * equal current value per bin — so the position marks at exactly `valueQuote`
 * at the moment it is opened.
 */
export function distributeSpot(
  lowerBinId: number,
  upperBinId: number,
  activeBinId: number,
  activePrice: number,
  valueQuote: number,
): VirtualBin[] {
  const nBins = upperBinId - lowerBinId + 1;
  if (nBins <= 0) throw new Error('distributeSpot: empty range');
  if (!(activePrice > 0)) throw new Error('distributeSpot: non-positive price');
  const perBin = valueQuote / nBins;

  const bins: VirtualBin[] = [];
  for (let binId = lowerBinId; binId <= upperBinId; binId++) {
    if (binId < activeBinId) {
      bins.push({ binId, base: 0, quote: perBin });
    } else if (binId > activeBinId) {
      bins.push({ binId, base: perBin / activePrice, quote: 0 });
    } else {
      bins.push({ binId, base: perBin / 2 / activePrice, quote: perBin / 2 });
    }
  }
  return bins;
}

function totals(bins: VirtualBin[]): { base: number; quote: number } {
  let base = 0;
  let quote = 0;
  for (const bin of bins) {
    base += bin.base;
    quote += bin.quote;
  }
  return { base, quote };
}

/** Mark-to-market value of the position's inventory, excluding pending fees. */
export function positionValueQuote(position: VirtualPosition, price: number): number {
  return position.base * price + position.quote;
}

export function openPosition(
  snapshot: PoolSnapshot,
  lowerBinId: number,
  upperBinId: number,
  navUsd: number,
): VirtualPosition {
  const bins = distributeSpot(
    lowerBinId,
    upperBinId,
    snapshot.activeBinId,
    snapshot.activePrice,
    navUsd,
  );
  const { base, quote } = totals(bins);
  return {
    status: 'ACTIVE',
    lowerBinId,
    upperBinId,
    base,
    quote,
    bins,
    pendingFeesQuote: 0,
    cumFeesQuote: 0,
    cumCostsQuote: 0,
    openedAt: snapshot.ts,
    lastRebalanceAt: snapshot.ts,
    oorSince: null,
    lastMarkPrice: snapshot.activePrice,
    lastMarkBinId: snapshot.activeBinId,
  };
}

/**
 * Walks the active bin to its new location, converting the inventory of every
 * bin it crossed **at that bin's own price**. This is where impermanent loss
 * comes from: a bin that flips from base to quote sells at its bin price, not at
 * the price the market ended up at.
 *
 * Also maintains `oorSince`, the clock the rebalance dwell gate reads.
 */
export function markPosition(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
): VirtualPosition {
  if (position.status === 'EXITED') {
    return { ...position, lastMarkPrice: snapshot.activePrice, lastMarkBinId: snapshot.activeBinId };
  }

  const bins = position.bins.map((bin) => {
    const price = binPrice(
      bin.binId,
      snapshot.activeBinId,
      snapshot.activePrice,
      snapshot.binStepBps,
    );
    if (bin.binId < snapshot.activeBinId && bin.base > 0) {
      return { binId: bin.binId, base: 0, quote: bin.quote + bin.base * price };
    }
    if (bin.binId > snapshot.activeBinId && bin.quote > 0 && price > 0) {
      return { binId: bin.binId, base: bin.base + bin.quote / price, quote: 0 };
    }
    return { ...bin };
  });

  const { base, quote } = totals(bins);
  const inRange = isInRange(snapshot, position.lowerBinId, position.upperBinId);
  const oorSince = inRange ? null : (position.oorSince ?? snapshot.ts);

  return {
    ...position,
    bins,
    base,
    quote,
    oorSince,
    lastMarkPrice: snapshot.activePrice,
    lastMarkBinId: snapshot.activeBinId,
  };
}

/** Quote-denominated value of our inventory sitting in the active bin. */
export function ourLiquidityInActiveBin(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
): number {
  if (position.status === 'EXITED') return 0;
  const bin = position.bins.find((b) => b.binId === snapshot.activeBinId);
  if (!bin) return 0;
  return bin.base * snapshot.activePrice + bin.quote;
}

/**
 * DLMM pays swap fees only to liquidity in the active bin, so our take is our
 * share of that bin (§9).
 *
 * `poolFeesIntervalUsd` is derived from the pool's reported fee stats, which is
 * an approximation — it attributes pool-wide fees to the interval rather than
 * reading per-bin fee growth on chain. Good enough to score a strategy, not
 * good enough to reconcile against a real position.
 */
export function accrueFees(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
): { position: VirtualPosition; feesTick: number; share: number } {
  const intervalFees = snapshot.poolFeesIntervalUsd ?? 0;
  const inRange = isInRange(snapshot, position.lowerBinId, position.upperBinId);
  if (position.status === 'EXITED' || !inRange || intervalFees <= 0) {
    return { position, feesTick: 0, share: 0 };
  }

  const ourLiq = ourLiquidityInActiveBin(position, snapshot);
  const denominator = snapshot.liqActiveBin + ourLiq;
  if (!(denominator > 0) || ourLiq <= 0) {
    return { position, feesTick: 0, share: 0 };
  }

  // Our virtual liquidity dilutes the bin it joins, so it belongs in the
  // denominator as well as the numerator.
  const share = ourLiq / denominator;
  const feesTick = share * intervalFees;

  return {
    position: {
      ...position,
      pendingFeesQuote: position.pendingFeesQuote + feesTick,
      cumFeesQuote: position.cumFeesQuote + feesTick,
    },
    feesTick,
    share,
  };
}

/**
 * Fold pending fees back into the same range. Charged the cost of a claim +
 * deposit; no swap leg, so no slippage.
 */
export function applyCompound(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
  costEst: CostEstimate,
): VirtualPosition {
  const value =
    positionValueQuote(position, snapshot.activePrice) +
    position.pendingFeesQuote -
    costEst.totalUsd;
  const bins = distributeSpot(
    position.lowerBinId,
    position.upperBinId,
    snapshot.activeBinId,
    snapshot.activePrice,
    Math.max(0, value),
  );
  const { base, quote } = totals(bins);
  return {
    ...position,
    bins,
    base,
    quote,
    pendingFeesQuote: 0,
    cumCostsQuote: position.cumCostsQuote + costEst.totalUsd,
    lastMarkPrice: snapshot.activePrice,
    lastMarkBinId: snapshot.activeBinId,
  };
}

/**
 * Close, pay the estimated cost, and redeploy the whole remainder into the new
 * range. Realized impermanent loss is already baked into the marked value.
 */
export function applyRebalance(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
  newLowerBin: number,
  newUpperBin: number,
  costEst: CostEstimate,
): VirtualPosition {
  const value =
    positionValueQuote(position, snapshot.activePrice) +
    position.pendingFeesQuote -
    costEst.totalUsd;
  const bins = distributeSpot(
    newLowerBin,
    newUpperBin,
    snapshot.activeBinId,
    snapshot.activePrice,
    Math.max(0, value),
  );
  const { base, quote } = totals(bins);
  return {
    ...position,
    lowerBinId: newLowerBin,
    upperBinId: newUpperBin,
    bins,
    base,
    quote,
    pendingFeesQuote: 0,
    cumCostsQuote: position.cumCostsQuote + costEst.totalUsd,
    lastRebalanceAt: snapshot.ts,
    oorSince: null,
    lastMarkPrice: snapshot.activePrice,
    lastMarkBinId: snapshot.activeBinId,
  };
}

/** Convert to a 50/50 basket and stop. Benchmarks keep marking afterwards. */
export function applyExit(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
  costEst: CostEstimate,
): VirtualPosition {
  const value = Math.max(
    0,
    positionValueQuote(position, snapshot.activePrice) +
      position.pendingFeesQuote -
      costEst.totalUsd,
  );
  return {
    ...position,
    status: 'EXITED',
    bins: [],
    base: snapshot.activePrice > 0 ? value / 2 / snapshot.activePrice : 0,
    quote: value / 2,
    pendingFeesQuote: 0,
    cumCostsQuote: position.cumCostsQuote + costEst.totalUsd,
    oorSince: null,
    lastMarkPrice: snapshot.activePrice,
    lastMarkBinId: snapshot.activeBinId,
  };
}

/** Share of snapshots the position has spent with price inside its range. */
export function timeInRangeShare(inRangeTicks: number, totalTicks: number): number {
  return totalTicks > 0 ? inRangeTicks / totalTicks : 0;
}

/** Convenience for callers that need the whole opening decision in one step. */
export function openFromPlan(
  snapshot: PoolSnapshot,
  plan: { lowerBinId: number; upperBinId: number },
  params: Params,
): VirtualPosition {
  return openPosition(snapshot, plan.lowerBinId, plan.upperBinId, params.virtualNavUsd);
}
