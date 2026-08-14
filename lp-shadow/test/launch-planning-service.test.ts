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
      binStepBps: 50,
      baseFeeBps: 30,
      distributionShape: 'SPOT',
      fundedBins: 69,
    });
    expect(report.plan.distributionShape).toBe('SPOT');
    expect(report.plan.fundedRange.totalBins).toBe(69);
    expect(report.comparisons).toHaveLength(12);
    expect(report.blockers).toContain('Project token mint address is still required.');
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
