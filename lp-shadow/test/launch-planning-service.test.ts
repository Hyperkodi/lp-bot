import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/service/errors.js';
import { planInitialLiquidityForLaunch } from '../src/service/launchPlanning.js';

describe('initial-liquidity planning service', () => {
  it('returns a read-only wide Spot default and all comparisons', () => {
    const report = planInitialLiquidityForLaunch({
      tokenAmount: 10_000_000,
      solAmount: 132,
      tokenSupply: 1_000_000_000,
      tokenDecimals: 6,
      solPriceUsd: 75.89,
    });
    expect(report.status).toBe('READ_ONLY');
    expect(report.defaults).toMatchObject({
      poolType: 'DLMM_STANDARD_DUAL_SIDED',
      binStepBps: 50,
      baseFeeBps: 30,
      distributionShape: 'SPOT',
      fundedBins: 69,
    });
    expect(report.plan.distributionShape).toBe('SPOT');
    expect(report.plan.fundedRange.totalBins).toBe(69);
    expect(report.comparisons).toHaveLength(12);
    expect(report.strategyDecision.selected).toBe('SPOT_69');
    expect(report.strategyDecision.wideComparison).toHaveLength(3);
    expect(report.executionCapReadiness.status).toBe('BLOCKED_BY_CONFIGURED_CAPS');
    expect(report.executionCapReadiness.blockers).toHaveLength(3);
    expect(report.binStepSensitivity.map((row) => row.binStepBps)).toEqual([10, 25, 50, 100, 200]);
    const spot = report.strategyDecision.wideComparison.find(
      (candidate) => candidate.distributionShape === 'SPOT',
    )!;
    const curve = report.strategyDecision.wideComparison.find(
      (candidate) => candidate.distributionShape === 'CURVE',
    )!;
    expect(curve.openingCapacityAtOnePctSol).toBeGreaterThan(spot.openingCapacityAtOnePctSol);
    expect(spot.minimumSampledInRangeCapacityAtOnePctSol).toBeGreaterThan(
      curve.minimumSampledInRangeCapacityAtOnePctSol,
    );
    expect(report.blockers).toContain('Project token mint address is still required.');
    expect(report.blockers.some((blocker) => blocker.includes('Standard-pool preset'))).toBe(true);
    expect(report.blockers.some((blocker) => blocker.includes('per-transaction cap'))).toBe(true);
  });

  it('maps planner validation failures to the public service error', () => {
    expect(() =>
      planInitialLiquidityForLaunch({
        tokenAmount: 10,
        solAmount: -1,
        tokenSupply: 100,
        tokenDecimals: 6,
        solPriceUsd: 75,
      }),
    ).toThrow(ServiceError);
  });
});
