import { describe, expect, it } from 'vitest';
import { loadRawConfig, toParams } from '../src/config.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import { syntheticStrategyScenarios } from '../src/strategy/lab.js';
import {
  evaluateTreasuryCandidate,
  lockTreasuryCandidate,
  selectTreasuryCandidate,
  treasuryQuoteCandidates,
  type TreasuryCandidateScore,
} from '../src/strategy/tuning.js';

const baseline = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);

describe('training-only treasury parameter selection', () => {
  it('builds a fixed, unique quote-exposure grid including the current profile', () => {
    expect(treasuryQuoteCandidates().map((candidate) => candidate.deployedQuoteShare)).toEqual([
      0,
      0.05,
      0.1,
      0.15,
      0.2,
      0.3,
      0.5,
    ]);
  });

  it('uses a robust deterministic ordering instead of average return alone', () => {
    const score = (
      quote: number,
      median: number,
      worst: number,
      drawdown: number,
      average: number,
    ): TreasuryCandidateScore => ({
      candidate: { name: `quote-${quote}`, deployedQuoteShare: quote },
      scenarioCount: 3,
      averageNetVsHodlUsd: average,
      medianNetVsHodlUsd: median,
      worstNetVsHodlUsd: worst,
      averageMaxDrawdownPct: drawdown,
      averageRebalances: 0,
    });
    const averageOutlier = score(0.5, -100, -2_000, 0.4, 10_000);
    const robust = score(0.1, 20, -500, 0.2, 100);

    expect(selectTreasuryCandidate([averageOutlier, robust]).candidate).toEqual(robust.candidate);
  });

  it('locks on the supplied training scenarios before holdout evaluation', () => {
    const [training, ...holdout] = syntheticStrategyScenarios();
    const locked = lockTreasuryCandidate(baseline, [training!]);
    const before = structuredClone(locked);
    const holdoutScore = evaluateTreasuryCandidate(baseline, holdout, locked.candidate);

    expect(locked).toEqual(before);
    expect(locked.score.scenarioCount).toBe(1);
    expect(holdoutScore.scenarioCount).toBe(3);
    expect(Number.isFinite(holdoutScore.medianNetVsHodlUsd)).toBe(true);
  });
});
