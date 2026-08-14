import { describe, expect, it } from 'vitest';
import { assessLaunchExecutionCaps } from '../src/strategy/launchExecutionCaps.js';
import { planInitialLiquidity } from '../src/strategy/launchPlanner.js';

const plan = planInitialLiquidity({
  tokenAmount: 10_000_000,
  solAmount: 132,
  tokenSupply: 1_000_000_000,
  tokenDecimals: 6,
  solPriceUsd: 75.89,
  binStepBps: 50,
  baseFeeBps: 30,
  distributionShape: 'SPOT',
  totalBins: 69,
  buyerOrderSol: 0,
  maxBuyerImpactBps: 100,
  gasReserveSol: 0.05,
});

describe('launch execution cap readiness', () => {
  it('reports every current placeholder cap exceeded by the reviewed plan', () => {
    const result = assessLaunchExecutionCaps(plan, {
      perTransactionSol: 10,
      projectRolling24hSol: 50,
      globalRolling24hSol: 250,
    });
    expect(result.status).toBe('BLOCKED_BY_CONFIGURED_CAPS');
    expect(result.plannedNotionalSol.openPosition).toBeCloseTo(
      plan.deposit.initialLiquidityValueSol,
    );
    expect(result.plannedNotionalSol.openPosition).toBeGreaterThan(263.7);
    expect(result.plannedNotionalSol.combined).toBeGreaterThan(263.9);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/per-transaction/i),
      expect.stringMatching(/project 24-hour/i),
      expect.stringMatching(/global 24-hour/i),
    ]));
  });

  it('includes existing rolling usage and accepts deliberately larger caps', () => {
    const caps = {
      perTransactionSol: 300,
      projectRolling24hSol: 400,
      globalRolling24hSol: 1_000,
    };
    expect(assessLaunchExecutionCaps(plan, caps).status).toBe('WITHIN_CONFIGURED_CAPS');
    expect(assessLaunchExecutionCaps(plan, caps, {
      projectSol: 150,
      globalSol: 800,
    }).status).toBe('BLOCKED_BY_CONFIGURED_CAPS');
  });
});
