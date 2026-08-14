import {
  compareInitialLiquidityPlans,
  planInitialLiquidity,
  type LaunchPlanInput,
} from '../strategy/launchPlanner.js';
import { ServiceError } from './errors.js';
import type {
  InitialLiquidityPlanningReport,
  InitialLiquidityPlanRequest,
} from './types.js';

const DEFAULTS = Object.freeze({
  poolType: 'DLMM_STANDARD_DUAL_SIDED' as const,
  binStepBps: 50 as const,
  baseFeeBps: 30 as const,
  distributionShape: 'SPOT' as const,
  fundedBins: 69 as const,
  averageImpactBps: 100 as const,
  gasReserveSol: 0.05 as const,
});

/** Read-only service boundary for the Telegram launch-planning flow. */
export function planInitialLiquidityForLaunch(
  input: InitialLiquidityPlanRequest,
): InitialLiquidityPlanningReport {
  const planningInput: LaunchPlanInput = {
    ...input,
    binStepBps: DEFAULTS.binStepBps,
    baseFeeBps: DEFAULTS.baseFeeBps,
    distributionShape: DEFAULTS.distributionShape,
    totalBins: DEFAULTS.fundedBins,
    buyerOrderSol: 0,
    maxBuyerImpactBps: DEFAULTS.averageImpactBps,
    gasReserveSol: DEFAULTS.gasReserveSol,
  };
  try {
    return {
      status: 'READ_ONLY',
      defaults: DEFAULTS,
      plan: planInitialLiquidity(planningInput),
      comparisons: compareInitialLiquidityPlans(planningInput),
      blockers: [
        'Project token mint address is still required.',
        'Token decimals must be verified against that mint.',
        'A Standard-pool preset supporting the provisional 50 bps bin step and 30 bps base fee must be verified on the target cluster.',
        'Exact devnet account and transaction costs require unsigned preflight.',
        'Founder confirmation is required before any execution workflow.',
      ],
    };
  } catch (error) {
    throw new ServiceError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
    );
  }
}
