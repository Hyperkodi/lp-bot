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
  DistributionShape,
  InventoryPolicy,
  Params,
  PoolSnapshot,
  VirtualBin,
  VirtualPosition,
} from '../types.js';

export const BALANCED_INVENTORY_POLICY: Readonly<InventoryPolicy> = Object.freeze({
  deployedBaseShare: 0.5,
  deployedQuoteShare: 0.5,
});

function validateInventoryPolicy(policy: InventoryPolicy): void {
  const { deployedBaseShare, deployedQuoteShare } = policy;
  if (
    !Number.isFinite(deployedBaseShare) ||
    !Number.isFinite(deployedQuoteShare) ||
    deployedBaseShare < 0 ||
    deployedQuoteShare < 0 ||
    deployedBaseShare + deployedQuoteShare > 1
  ) {
    throw new Error('inventory policy shares must be finite, non-negative, and sum to at most 1');
  }
}

function shapeWeight(
  shape: DistributionShape,
  binId: number,
  activeBinId: number,
  lowerBinId: number,
  upperBinId: number,
): number {
  if (shape === 'SPOT') return 1;
  const standardDeviation = Math.max((upperBinId - lowerBinId) / 4, 1);
  const distance = (binId - activeBinId) / standardDeviation;
  const gaussian = Math.exp(-(distance * distance) / 2);
  return shape === 'CURVE' ? gaussian : 1 / gaussian;
}

/**
 * Mirrors Meteora's three balanced strategy families in plain numbers. Each
 * side is normalized independently because the SDK allocates all supplied X
 * above the active bin and all supplied Y below it; the active bin receives
 * half of each side's raw weight.
 */
export function distributeByShape(
  lowerBinId: number,
  upperBinId: number,
  activeBinId: number,
  activePrice: number,
  valueQuote: number,
  shape: DistributionShape,
  inventoryPolicy: InventoryPolicy = BALANCED_INVENTORY_POLICY,
): VirtualBin[] {
  const nBins = upperBinId - lowerBinId + 1;
  if (nBins <= 0) throw new Error('distributeByShape: empty range');
  if (!(activePrice > 0)) throw new Error('distributeByShape: non-positive price');
  if (!(valueQuote >= 0)) throw new Error('distributeByShape: negative value');
  validateInventoryPolicy(inventoryPolicy);

  const rows = Array.from({ length: nBins }, (_, offset) => {
    const binId = lowerBinId + offset;
    return {
      binId,
      weight: shapeWeight(shape, binId, activeBinId, lowerBinId, upperBinId),
    };
  });
  const quoteWeight = rows.reduce(
    (total, row) => total + (row.binId < activeBinId ? row.weight : row.binId === activeBinId ? row.weight / 2 : 0),
    0,
  );
  const baseWeight = rows.reduce(
    (total, row) => total + (row.binId > activeBinId ? row.weight : row.binId === activeBinId ? row.weight / 2 : 0),
    0,
  );

  // Each side receives only the budget allowed by the inventory policy. Any
  // undeployed value is accounted for as reserve by `allocatePosition`.
  const quoteBudget = valueQuote * inventoryPolicy.deployedQuoteShare;
  const baseBudget = valueQuote * inventoryPolicy.deployedBaseShare;
  return rows.map(({ binId, weight }) => {
    const quoteShare = binId < activeBinId ? weight : binId === activeBinId ? weight / 2 : 0;
    const baseShare = binId > activeBinId ? weight : binId === activeBinId ? weight / 2 : 0;
    return {
      binId,
      quote: quoteWeight > 0 ? (quoteBudget * quoteShare) / quoteWeight : 0,
      base: baseWeight > 0 ? (baseBudget * baseShare) / baseWeight / activePrice : 0,
    };
  });
}

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
  return distributeByShape(
    lowerBinId,
    upperBinId,
    activeBinId,
    activePrice,
    valueQuote,
    'SPOT',
  );
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
  return position.base * price + position.quote + position.reserveQuote;
}

function allocatePosition(
  lowerBinId: number,
  upperBinId: number,
  activeBinId: number,
  activePrice: number,
  valueQuote: number,
  distributionShape: DistributionShape,
  inventoryPolicy: InventoryPolicy,
): { bins: VirtualBin[]; base: number; quote: number; reserveQuote: number } {
  const bins = distributeByShape(
    lowerBinId,
    upperBinId,
    activeBinId,
    activePrice,
    valueQuote,
    distributionShape,
    inventoryPolicy,
  );
  const { base, quote } = totals(bins);
  const deployedValue = base * activePrice + quote;
  return {
    bins,
    base,
    quote,
    reserveQuote: Math.max(0, valueQuote - deployedValue),
  };
}

export function openPosition(
  snapshot: PoolSnapshot,
  lowerBinId: number,
  upperBinId: number,
  navUsd: number,
  distributionShape: DistributionShape = 'SPOT',
  inventoryPolicy: InventoryPolicy = BALANCED_INVENTORY_POLICY,
): VirtualPosition {
  const allocation = allocatePosition(
    lowerBinId,
    upperBinId,
    snapshot.activeBinId,
    snapshot.activePrice,
    navUsd,
    distributionShape,
    inventoryPolicy,
  );
  return {
    status: 'ACTIVE',
    lowerBinId,
    upperBinId,
    base: allocation.base,
    quote: allocation.quote,
    reserveQuote: allocation.reserveQuote,
    bins: allocation.bins,
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

export type BuyerSwapSimulation = {
  requestedQuoteUsd: number;
  filledQuoteUsd: number;
  baseReceived: number;
  averagePrice: number | null;
  slippageBps: number;
  fillRate: number;
};

/**
 * Simulates a quote-to-base buyer walking only this virtual position's bins.
 * It deliberately excludes pool liquidity owned by other LPs and swap fees,
 * making this a profile contribution metric rather than a full route quote.
 */
export function simulateBuyerSwap(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
  requestedQuoteUsd: number,
): BuyerSwapSimulation {
  if (!Number.isFinite(requestedQuoteUsd) || requestedQuoteUsd < 0) {
    throw new Error('buyer quote notional must be finite and non-negative');
  }
  if (position.status === 'EXITED' || requestedQuoteUsd === 0) {
    return {
      requestedQuoteUsd,
      filledQuoteUsd: 0,
      baseReceived: 0,
      averagePrice: null,
      slippageBps: 0,
      fillRate: requestedQuoteUsd === 0 ? 1 : 0,
    };
  }

  let remaining = requestedQuoteUsd;
  let filledQuoteUsd = 0;
  let baseReceived = 0;
  const sellBins = position.bins
    .filter((bin) => bin.binId >= snapshot.activeBinId && bin.base > 0)
    .sort((a, b) => a.binId - b.binId);
  for (const bin of sellBins) {
    if (remaining <= 0) break;
    const price = binPrice(
      bin.binId,
      snapshot.activeBinId,
      snapshot.activePrice,
      snapshot.binStepBps,
    );
    if (!(price > 0)) continue;
    const fillQuote = Math.min(remaining, bin.base * price);
    filledQuoteUsd += fillQuote;
    baseReceived += fillQuote / price;
    remaining -= fillQuote;
  }

  const averagePrice = baseReceived > 0 ? filledQuoteUsd / baseReceived : null;
  const slippageBps =
    averagePrice !== null && snapshot.activePrice > 0
      ? Math.max(0, (averagePrice / snapshot.activePrice - 1) * 10_000)
      : 0;
  return {
    requestedQuoteUsd,
    filledQuoteUsd,
    baseReceived,
    averagePrice,
    slippageBps,
    fillRate: requestedQuoteUsd > 0 ? filledQuoteUsd / requestedQuoteUsd : 1,
  };
}

/** Quote a buyer can spend before reaching the requested marginal impact. */
export function buyDepthWithinPriceImpact(
  position: VirtualPosition,
  snapshot: PoolSnapshot,
  maxImpactBps: number,
): number {
  if (!Number.isFinite(maxImpactBps) || maxImpactBps < 0) {
    throw new Error('maximum price impact must be finite and non-negative');
  }
  if (position.status === 'EXITED' || !(snapshot.activePrice > 0)) return 0;
  const limitPrice = snapshot.activePrice * (1 + maxImpactBps / 10_000);
  return position.bins.reduce((depth, bin) => {
    if (bin.binId < snapshot.activeBinId || bin.base <= 0) return depth;
    const price = binPrice(
      bin.binId,
      snapshot.activeBinId,
      snapshot.activePrice,
      snapshot.binStepBps,
    );
    return price <= limitPrice ? depth + bin.base * price : depth;
  }, 0);
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
  distributionShape: DistributionShape = 'SPOT',
  inventoryPolicy: InventoryPolicy = BALANCED_INVENTORY_POLICY,
): VirtualPosition {
  const value =
    positionValueQuote(position, snapshot.activePrice) +
    position.pendingFeesQuote -
    costEst.totalUsd;
  const allocation = allocatePosition(
    position.lowerBinId,
    position.upperBinId,
    snapshot.activeBinId,
    snapshot.activePrice,
    Math.max(0, value),
    distributionShape,
    inventoryPolicy,
  );
  return {
    ...position,
    bins: allocation.bins,
    base: allocation.base,
    quote: allocation.quote,
    reserveQuote: allocation.reserveQuote,
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
  distributionShape: DistributionShape = 'SPOT',
  inventoryPolicy: InventoryPolicy = BALANCED_INVENTORY_POLICY,
): VirtualPosition {
  const value =
    positionValueQuote(position, snapshot.activePrice) +
    position.pendingFeesQuote -
    costEst.totalUsd;
  const allocation = allocatePosition(
    newLowerBin,
    newUpperBin,
    snapshot.activeBinId,
    snapshot.activePrice,
    Math.max(0, value),
    distributionShape,
    inventoryPolicy,
  );
  return {
    ...position,
    lowerBinId: newLowerBin,
    upperBinId: newUpperBin,
    bins: allocation.bins,
    base: allocation.base,
    quote: allocation.quote,
    reserveQuote: allocation.reserveQuote,
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
  target: 'BALANCED' | 'QUOTE' = 'BALANCED',
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
    base: target === 'BALANCED' && snapshot.activePrice > 0 ? value / 2 / snapshot.activePrice : 0,
    quote: target === 'QUOTE' ? value : value / 2,
    reserveQuote: 0,
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
