import { describe, expect, it } from 'vitest';
import {
  compareInitialLiquidityPlans,
  planInitialLiquidity,
  type LaunchPlanInput,
} from '../src/strategy/launchPlanner.js';

const launch: LaunchPlanInput = {
  tokenAmount: 1_000_000,
  solAmount: 10,
  tokenSupply: 100_000_000,
  solPriceUsd: 200,
  binStepBps: 25,
  baseFeeBps: 30,
  distributionShape: 'CURVE',
  totalBins: 15,
  buyerOrderSol: 5,
  maxBuyerImpactBps: 100,
  gasReserveSol: 0.05,
};

describe('initial-liquidity launch planner', () => {
  it('turns founder amounts into an executable 70-bin position plan', () => {
    const plan = planInitialLiquidity(launch);

    expect(plan.price).toMatchObject({
      mode: 'CREATE',
      priceSolPerToken: 0.00001,
      impliedFdvSol: 1_000,
      impliedFdvUsd: 200_000,
    });
    expect(plan.positionAccount).toEqual({ lowerBinId: -35, upperBinId: 34, width: 70 });
    expect(plan.fundedRange).toMatchObject({
      lowerBinId: -7,
      upperBinId: 7,
      totalBins: 15,
    });
    expect(plan.fundedRange.lowerPriceSolPerToken).toBeLessThan(plan.price.priceSolPerToken);
    expect(plan.fundedRange.upperPriceSolPerToken).toBeGreaterThan(plan.price.priceSolPerToken);
    expect(plan.deposit).toEqual({
      tokenAmount: 1_000_000,
      positionSolAmount: 10,
      gasReserveSol: 0.05,
      walletSolRequired: 10.05,
      initialLiquidityValueSol: 20,
      initialLiquidityValueUsd: 4_000,
    });
    expect(plan.buyer.requestedSol).toBe(5);
    expect(plan.buyer.requestedUsd).toBe(1_000);
    expect(plan.buyer.depthWithinImpactSol).toBeGreaterThan(0);
    expect(plan.buyer.fillRate).toBeGreaterThan(0);
    expect(plan.policy).toEqual({
      opensAtPoolCreation: true,
      remainsDeposited: true,
      founderWithdrawalAvailable: true,
      compounds: false,
      rebalances: false,
      exits: false,
      laterAdditionsIncluded: false,
    });
  });

  it('compares the twelve tested shape and width families using the same real deposit', () => {
    const plans = compareInitialLiquidityPlans(launch);

    expect(plans).toHaveLength(12);
    expect(new Set(plans.map((plan) => plan.distributionShape))).toEqual(
      new Set(['SPOT', 'CURVE', 'BID_ASK']),
    );
    expect(new Set(plans.map((plan) => plan.fundedRange.totalBins))).toEqual(
      new Set([15, 31, 51, 69]),
    );
    expect(plans.every((plan) => plan.deposit.tokenAmount === launch.tokenAmount)).toBe(true);
    expect(plans.every((plan) => plan.deposit.positionSolAmount === launch.solAmount)).toBe(true);
  });

  it('rejects plans that cannot fit the classic position or have unsafe numeric inputs', () => {
    expect(() => planInitialLiquidity({ ...launch, totalBins: 71 })).toThrow(/70-bin/i);
    expect(() => planInitialLiquidity({ ...launch, binStepBps: 0 })).toThrow(/bin step/i);
    expect(() => planInitialLiquidity({ ...launch, buyerOrderSol: -1 })).toThrow(/buyer order/i);
    expect(() => planInitialLiquidity({ ...launch, baseFeeBps: 10_001 })).toThrow(/base fee/i);
  });
});
