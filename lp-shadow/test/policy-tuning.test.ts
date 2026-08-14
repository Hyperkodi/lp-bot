import { describe, expect, it } from 'vitest';
import { loadRawConfig, toParams } from '../src/config.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import { syntheticStrategyScenarios } from '../src/strategy/lab.js';
import {
  evaluatePolicyCandidate,
  experimentalPolicyCandidates,
  lockPolicyCandidate,
} from '../src/strategy/policyTuning.js';

const baseline = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);

describe('structural policy tuning', () => {
  it('crosses delayed entry, one-sided inventory, and explicit exit families', () => {
    const candidates = experimentalPolicyCandidates();
    expect(candidates).toHaveLength(64);
    expect(candidates.some((candidate) => candidate.entryDelayHours === 36)).toBe(true);
    expect(candidates.some((candidate) => candidate.inventory === 'QUOTE_ONLY')).toBe(true);
    expect(candidates.some((candidate) => candidate.inventory === 'BASE_ONLY')).toBe(true);
    expect(candidates.some((candidate) => candidate.exit === 'STOP_20')).toBe(true);
    expect(candidates.some((candidate) => candidate.exit === 'TRAIL_20')).toBe(true);
    expect(candidates.some((candidate) => candidate.exit === 'TIME_48')).toBe(true);
  });

  it('locks from training inputs before separately scoring holdout', () => {
    const scenarios = syntheticStrategyScenarios();
    const locked = lockPolicyCandidate(baseline, scenarios.slice(0, 2));
    const snapshot = structuredClone(locked);
    const holdout = evaluatePolicyCandidate(baseline, scenarios.slice(2), locked.candidate);

    expect(locked).toEqual(snapshot);
    expect(locked.score.scenarioCount).toBe(2);
    expect(holdout.scenarioCount).toBe(2);
    expect(Number.isFinite(holdout.medianNetVsHodlUsd)).toBe(true);
  });
});
