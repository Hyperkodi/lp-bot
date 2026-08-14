import { runVariant, type ReplayResult } from '../replay/replay.js';
import type { DistributionShape, InventoryPolicy, Params } from '../types.js';
import {
  buyDepthWithinPriceImpact,
  openPosition,
  simulateBuyerSwap,
} from '../virtual/position.js';
import type { StrategyScenario } from './lab.js';

export type InitialLiquidityInventory =
  | 'TOKEN_ONLY'
  | 'TOKEN_HEAVY'
  | 'BALANCED'
  | 'QUOTE_HEAVY';

export type InitialLiquidityCandidate = {
  name: string;
  distributionShape: DistributionShape;
  inventory: InitialLiquidityInventory;
  totalBins: number;
};

export type InitialLiquidityScore = {
  candidate: InitialLiquidityCandidate;
  scenarioCount: number;
  averageNetVsHodlUsd: number;
  medianNetVsHodlUsd: number;
  worstNetVsHodlUsd: number;
  averageMaxDrawdownPct: number;
  averageFeesUsd: number;
  averageTimeInRange: number;
  averageInitialBuyerDepth1PctUsd: number;
  averageInitialBuyerFillRate: number;
  averageBuyerDepth1PctUsd: number;
  averageBuyerFillRate: number;
  averageBuyerSlippageBps: number;
};

export type InitialLiquidityScenarioResult = { scenario: string; replay: ReplayResult };

const SHAPES: readonly DistributionShape[] = Object.freeze(['SPOT', 'CURVE', 'BID_ASK']);
const INVENTORIES: readonly InitialLiquidityInventory[] = Object.freeze([
  'TOKEN_ONLY',
  'TOKEN_HEAVY',
  'BALANCED',
  'QUOTE_HEAVY',
]);
const WIDTHS = Object.freeze([15, 31, 51, 69]);

export function initialLiquidityCandidates(): InitialLiquidityCandidate[] {
  return SHAPES.flatMap((distributionShape) => INVENTORIES.flatMap((inventory) =>
    WIDTHS.map((totalBins) => ({
      name: `${distributionShape.toLowerCase()}_${inventory.toLowerCase()}_${totalBins}bins`,
      distributionShape,
      inventory,
      totalBins,
    })),
  ));
}

export function initialLiquidityInventoryPolicy(
  inventory: InitialLiquidityInventory,
): InventoryPolicy {
  switch (inventory) {
    case 'TOKEN_ONLY':
      return { deployedBaseShare: 1, deployedQuoteShare: 0 };
    case 'TOKEN_HEAVY':
      return { deployedBaseShare: 0.7, deployedQuoteShare: 0.3 };
    case 'BALANCED':
      return { deployedBaseShare: 0.5, deployedQuoteShare: 0.5 };
    case 'QUOTE_HEAVY':
      return { deployedBaseShare: 0.3, deployedQuoteShare: 0.7 };
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function runInitialLiquidityCandidate(
  baseline: Params,
  scenarios: StrategyScenario[],
  candidate: InitialLiquidityCandidate,
): InitialLiquidityScenarioResult[] {
  if (scenarios.length === 0) {
    throw new Error('initial-liquidity evaluation requires at least one scenario');
  }
  const policy = initialLiquidityInventoryPolicy(candidate.inventory);
  return scenarios.map((scenario) => ({
    scenario: scenario.name,
    replay: runVariant({
      name: candidate.name,
      params: baseline,
      distributionShape: candidate.distributionShape,
      inventoryPolicy: policy,
      benchmarkAtScenarioStart: true,
      hodlBaseShare: policy.deployedBaseShare,
      openAtScenarioStart: true,
      initialRangeBins: candidate.totalBins,
      passiveLiquidity: true,
      poolCreatedAtMs: scenario.snapshots[0]?.snapshot.ts,
    }, scenario.snapshots),
  }));
}

export function evaluateInitialLiquidityCandidate(
  baseline: Params,
  scenarios: StrategyScenario[],
  candidate: InitialLiquidityCandidate,
): InitialLiquidityScore {
  const results = runInitialLiquidityCandidate(baseline, scenarios, candidate)
    .map((row) => row.replay);
  const policy = initialLiquidityInventoryPolicy(candidate.inventory);
  const initialBuyerMetrics = scenarios.map((scenario) => {
    const snapshot = scenario.snapshots[0]?.snapshot;
    if (!snapshot) throw new Error(`${scenario.name} has no initial-liquidity snapshot`);
    const half = Math.floor(candidate.totalBins / 2);
    const position = openPosition(
      snapshot,
      snapshot.activeBinId - half,
      snapshot.activeBinId + half,
      baseline.virtualNavUsd,
      candidate.distributionShape,
      policy,
    );
    return {
      depth: buyDepthWithinPriceImpact(position, snapshot, 100),
      fill: simulateBuyerSwap(position, snapshot, baseline.virtualNavUsd * 0.1).fillRate,
    };
  });
  const net = results.map((result) => result.netVsHodlUsd);
  return {
    candidate,
    scenarioCount: results.length,
    averageNetVsHodlUsd: average(net),
    medianNetVsHodlUsd: median(net),
    worstNetVsHodlUsd: Math.min(...net),
    averageMaxDrawdownPct: average(results.map((result) => result.maxDrawdownPct)),
    averageFeesUsd: average(results.map((result) => result.totalFeesUsd)),
    averageTimeInRange: average(results.map((result) => result.timeInRange)),
    averageInitialBuyerDepth1PctUsd: average(initialBuyerMetrics.map((metric) => metric.depth)),
    averageInitialBuyerFillRate: average(initialBuyerMetrics.map((metric) => metric.fill)),
    averageBuyerDepth1PctUsd: average(
      results.map((result) => result.averageBuyDepth1PctUsd),
    ),
    averageBuyerFillRate: average(results.map((result) => result.buyerOrderFillRate)),
    averageBuyerSlippageBps: average(results.map((result) => result.averageBuyerSlippageBps)),
  };
}

function firstBy(
  scores: InitialLiquidityScore[],
  compare: (a: InitialLiquidityScore, b: InitialLiquidityScore) => number,
): InitialLiquidityScore {
  if (scores.length === 0) throw new Error('cannot select from empty initial-liquidity scores');
  return [...scores].sort((a, b) => compare(a, b) || a.candidate.name.localeCompare(b.candidate.name))[0]!;
}

/**
 * Four training-only representatives. The founder can choose the objective;
 * the lab does not hide that capital, fees, depth, and durability trade off.
 */
export function selectInitialLiquidityOptions(scores: InitialLiquidityScore[]): {
  capital: InitialLiquidityScore;
  fees: InitialLiquidityScore;
  buyerDepth: InitialLiquidityScore;
  durability: InitialLiquidityScore;
} {
  return {
    capital: firstBy(scores, (a, b) =>
      b.medianNetVsHodlUsd - a.medianNetVsHodlUsd ||
      b.worstNetVsHodlUsd - a.worstNetVsHodlUsd ||
      a.averageMaxDrawdownPct - b.averageMaxDrawdownPct,
    ),
    fees: firstBy(scores, (a, b) =>
      b.averageFeesUsd - a.averageFeesUsd ||
      b.medianNetVsHodlUsd - a.medianNetVsHodlUsd,
    ),
    buyerDepth: firstBy(scores, (a, b) =>
      b.averageInitialBuyerDepth1PctUsd - a.averageInitialBuyerDepth1PctUsd ||
      b.averageInitialBuyerFillRate - a.averageInitialBuyerFillRate ||
      b.averageBuyerDepth1PctUsd - a.averageBuyerDepth1PctUsd ||
      a.averageBuyerSlippageBps - b.averageBuyerSlippageBps,
    ),
    durability: firstBy(scores, (a, b) =>
      b.averageTimeInRange - a.averageTimeInRange ||
      b.medianNetVsHodlUsd - a.medianNetVsHodlUsd,
    ),
  };
}
