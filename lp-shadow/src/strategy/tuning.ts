import { runVariant } from '../replay/replay.js';
import type { Params } from '../types.js';
import { profileVariants, rebinSnapshots, type StrategyScenario } from './lab.js';

export type TreasuryQuoteCandidate = {
  name: string;
  deployedQuoteShare: number;
};

export type TreasuryCandidateScore = {
  candidate: TreasuryQuoteCandidate;
  scenarioCount: number;
  averageNetVsHodlUsd: number;
  medianNetVsHodlUsd: number;
  worstNetVsHodlUsd: number;
  averageMaxDrawdownPct: number;
  averageRebalances: number;
};

const QUOTE_SHARES = Object.freeze([0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]);

export function treasuryQuoteCandidates(): TreasuryQuoteCandidate[] {
  return QUOTE_SHARES.map((deployedQuoteShare) => ({
    name: `treasury-quote-${String(Math.round(deployedQuoteShare * 100)).padStart(2, '0')}pct`,
    deployedQuoteShare,
  }));
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

export function evaluateTreasuryCandidate(
  baseline: Params,
  scenarios: StrategyScenario[],
  candidate: TreasuryQuoteCandidate,
): TreasuryCandidateScore {
  if (scenarios.length === 0) throw new Error('treasury tuning requires at least one scenario');
  if (
    !Number.isFinite(candidate.deployedQuoteShare) ||
    candidate.deployedQuoteShare < 0 ||
    candidate.deployedQuoteShare > 0.5
  ) {
    throw new Error('treasury deployed quote share must be between 0 and 0.5');
  }
  const profile = profileVariants(baseline).find(
    (variant) => variant.profileSlug === 'treasury-defensive',
  );
  if (!profile) throw new Error('treasury-defensive profile is unavailable');
  const results = scenarios.map((scenario) => runVariant(
    {
      ...profile,
      name: candidate.name,
      inventoryPolicy: {
        deployedBaseShare: profile.inventoryPolicy.deployedBaseShare,
        deployedQuoteShare: candidate.deployedQuoteShare,
      },
      poolCreatedAtMs: scenario.snapshots[0]?.snapshot.ts,
    },
    rebinSnapshots(scenario.snapshots, profile.defaultBinStepBps),
  ));
  const net = results.map((result) => result.netVsHodlUsd);
  return {
    candidate,
    scenarioCount: results.length,
    averageNetVsHodlUsd: average(net),
    medianNetVsHodlUsd: median(net),
    worstNetVsHodlUsd: Math.min(...net),
    averageMaxDrawdownPct: average(results.map((result) => result.maxDrawdownPct)),
    averageRebalances: average(results.map((result) => result.rebalances)),
  };
}

/**
 * Rank robustly: median and worst launch come before mean, so one explosive
 * winner cannot select a candidate that performed badly on most launches.
 */
export function selectTreasuryCandidate(
  scores: TreasuryCandidateScore[],
): TreasuryCandidateScore {
  if (scores.length === 0) throw new Error('cannot select from an empty candidate set');
  return [...scores].sort((a, b) =>
    b.medianNetVsHodlUsd - a.medianNetVsHodlUsd ||
    b.worstNetVsHodlUsd - a.worstNetVsHodlUsd ||
    a.averageMaxDrawdownPct - b.averageMaxDrawdownPct ||
    b.averageNetVsHodlUsd - a.averageNetVsHodlUsd ||
    a.averageRebalances - b.averageRebalances ||
    a.candidate.deployedQuoteShare - b.candidate.deployedQuoteShare
  )[0]!;
}

/** Holdout scenarios are deliberately absent from this API. */
export function lockTreasuryCandidate(
  baseline: Params,
  trainingScenarios: StrategyScenario[],
): { candidate: TreasuryQuoteCandidate; score: TreasuryCandidateScore; trainingScores: TreasuryCandidateScore[] } {
  const trainingScores = treasuryQuoteCandidates().map((candidate) =>
    evaluateTreasuryCandidate(baseline, trainingScenarios, candidate),
  );
  const score = selectTreasuryCandidate(trainingScores);
  return { candidate: score.candidate, score, trainingScores };
}
