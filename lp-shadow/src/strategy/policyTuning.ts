import { runVariant, type ReplayResult, type Variant } from '../replay/replay.js';
import type { InventoryPolicy, Params } from '../types.js';
import { profileVariants, rebinSnapshots, type StrategyScenario } from './lab.js';

export type ExperimentalInventory =
  | 'BALANCED'
  | 'QUOTE_ONLY'
  | 'BASE_ONLY'
  | 'HALF_BASE_RESERVE';
export type ExperimentalExit = 'NONE' | 'STOP_20' | 'TRAIL_20' | 'TIME_48';

export type ExperimentalPolicyCandidate = {
  name: string;
  entryDelayHours: number;
  inventory: ExperimentalInventory;
  exit: ExperimentalExit;
};

export type ExperimentalPolicyScore = {
  candidate: ExperimentalPolicyCandidate;
  scenarioCount: number;
  averageNetVsHodlUsd: number;
  medianNetVsHodlUsd: number;
  worstNetVsHodlUsd: number;
  averageMaxDrawdownPct: number;
  averageFeesUsd: number;
  exitRate: number;
};

export type ExperimentalPolicyScenarioResult = {
  scenario: string;
  replay: ReplayResult;
};

const ENTRY_DELAYS = Object.freeze([0, 12, 24, 36]);
const INVENTORIES: readonly ExperimentalInventory[] = Object.freeze([
  'BALANCED',
  'QUOTE_ONLY',
  'BASE_ONLY',
  'HALF_BASE_RESERVE',
]);
const EXITS: readonly ExperimentalExit[] = Object.freeze([
  'NONE',
  'STOP_20',
  'TRAIL_20',
  'TIME_48',
]);

export function experimentalPolicyCandidates(): ExperimentalPolicyCandidate[] {
  return ENTRY_DELAYS.flatMap((entryDelayHours) => INVENTORIES.flatMap((inventory) =>
    EXITS.map((exit) => ({
      name: `delay-${entryDelayHours}h_${inventory.toLowerCase()}_${exit.toLowerCase()}`,
      entryDelayHours,
      inventory,
      exit,
    })),
  ));
}

function inventoryPolicy(inventory: ExperimentalInventory): InventoryPolicy {
  switch (inventory) {
    case 'BALANCED':
      return { deployedBaseShare: 0.5, deployedQuoteShare: 0.5 };
    case 'QUOTE_ONLY':
      return { deployedBaseShare: 0, deployedQuoteShare: 1 };
    case 'BASE_ONLY':
      return { deployedBaseShare: 1, deployedQuoteShare: 0 };
    case 'HALF_BASE_RESERVE':
      return { deployedBaseShare: 0.5, deployedQuoteShare: 0 };
  }
}

function explicitExitPolicy(exit: ExperimentalExit): Variant['explicitExitPolicy'] {
  switch (exit) {
    case 'NONE':
      return undefined;
    case 'STOP_20':
      return { stopLossPct: 0.2, target: 'QUOTE' };
    case 'TRAIL_20':
      return { trailingDrawdownPct: 0.2, target: 'QUOTE' };
    case 'TIME_48':
      return { maxHoldHours: 48, target: 'QUOTE' };
  }
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function evaluatePolicyCandidate(
  baseline: Params,
  scenarios: StrategyScenario[],
  candidate: ExperimentalPolicyCandidate,
): ExperimentalPolicyScore {
  if (scenarios.length === 0) throw new Error('policy tuning requires at least one scenario');
  const results = runPolicyCandidate(baseline, scenarios, candidate).map((row) => row.replay);
  const net = results.map((result) => result.netVsHodlUsd);
  return {
    candidate,
    scenarioCount: results.length,
    averageNetVsHodlUsd: average(net),
    medianNetVsHodlUsd: median(net),
    worstNetVsHodlUsd: Math.min(...net),
    averageMaxDrawdownPct: average(results.map((result) => result.maxDrawdownPct)),
    averageFeesUsd: average(results.map((result) => result.totalFeesUsd)),
    exitRate: results.filter((result) => result.exited).length / results.length,
  };
}

export function runPolicyCandidate(
  baseline: Params,
  scenarios: StrategyScenario[],
  candidate: ExperimentalPolicyCandidate,
): ExperimentalPolicyScenarioResult[] {
  if (scenarios.length === 0) throw new Error('policy tuning requires at least one scenario');
  const profile = profileVariants(baseline).find(
    (variant) => variant.profileSlug === 'treasury-defensive',
  );
  if (!profile) throw new Error('treasury-defensive profile is unavailable');
  const policy = inventoryPolicy(candidate.inventory);
  const entryCostUsd =
    baseline.virtualNavUsd * policy.deployedBaseShare * (baseline.quoteSlippageBps / 10_000);
  return scenarios.map((scenario) => ({
    scenario: scenario.name,
    replay: runVariant(
      {
        ...profile,
        name: candidate.name,
        params: { ...profile.params, volTvlFloor: 0 },
        inventoryPolicy: policy,
        entryDelayHours: candidate.entryDelayHours,
        benchmarkAtScenarioStart: true,
        entryCostUsd,
        explicitExitPolicy: explicitExitPolicy(candidate.exit),
        poolCreatedAtMs: scenario.snapshots[0]?.snapshot.ts,
      },
      rebinSnapshots(scenario.snapshots, profile.defaultBinStepBps),
    ),
  }));
}

/** Median and worst launch outrank the mean so a single 35x winner cannot select the policy. */
export function rankPolicyCandidates(scores: ExperimentalPolicyScore[]): ExperimentalPolicyScore[] {
  if (scores.length === 0) throw new Error('cannot select from an empty policy set');
  return [...scores].sort((a, b) =>
    b.medianNetVsHodlUsd - a.medianNetVsHodlUsd ||
    b.worstNetVsHodlUsd - a.worstNetVsHodlUsd ||
    a.averageMaxDrawdownPct - b.averageMaxDrawdownPct ||
    b.averageNetVsHodlUsd - a.averageNetVsHodlUsd ||
    b.averageFeesUsd - a.averageFeesUsd ||
    a.candidate.name.localeCompare(b.candidate.name)
  );
}

export function selectPolicyCandidate(scores: ExperimentalPolicyScore[]): ExperimentalPolicyScore {
  return rankPolicyCandidates(scores)[0]!;
}

/** Holdout scenarios are deliberately absent from the locking API. */
export function lockPolicyCandidate(
  baseline: Params,
  trainingScenarios: StrategyScenario[],
): {
  candidate: ExperimentalPolicyCandidate;
  score: ExperimentalPolicyScore;
  trainingScores: ExperimentalPolicyScore[];
} {
  const trainingScores = experimentalPolicyCandidates().map((candidate) =>
    evaluatePolicyCandidate(baseline, trainingScenarios, candidate),
  );
  const score = selectPolicyCandidate(trainingScores);
  return { candidate: score.candidate, score, trainingScores };
}
