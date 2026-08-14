import { describe, expect, it } from 'vitest';
import { loadRawConfig, toParams } from '../src/config.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import {
  evaluateInitialLiquidityCandidate,
  initialLiquidityCandidates,
  selectInitialLiquidityOptions,
} from '../src/strategy/initialLiquidity.js';
import { syntheticStrategyScenarios } from '../src/strategy/lab.js';

const baseline = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);

describe('permanent initial liquidity options', () => {
  it('crosses four launch-capable token/SOL mixes, three shapes, and four fixed widths', () => {
    const candidates = initialLiquidityCandidates();
    expect(candidates).toHaveLength(48);
    expect(new Set(candidates.map((candidate) => candidate.totalBins))).toEqual(
      new Set([15, 31, 51, 69]),
    );
    expect(new Set(candidates.map((candidate) => candidate.inventory))).toEqual(
      new Set(['TOKEN_ONLY', 'TOKEN_HEAVY', 'BALANCED', 'QUOTE_HEAVY']),
    );
  });

  it('selects training-only representatives for capital, fees, depth, and durability', () => {
    const scenarios = syntheticStrategyScenarios();
    const scores = initialLiquidityCandidates().map((candidate) =>
      evaluateInitialLiquidityCandidate(baseline, scenarios.slice(0, 2), candidate),
    );
    const options = selectInitialLiquidityOptions(scores);

    expect(Object.keys(options)).toEqual(['capital', 'fees', 'buyerDepth', 'durability']);
    expect(Object.values(options).every((score) => score.scenarioCount === 2)).toBe(true);
  });
});
