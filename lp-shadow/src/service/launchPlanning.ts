import {
  compareInitialLiquidityPlans,
  compareLaunchBinSteps,
  planInitialLiquidity,
  type LaunchPlanInput,
} from '../strategy/launchPlanner.js';
import type { ExecutionCaps } from '../execution/types.js';
import { assessLaunchExecutionCaps } from '../strategy/launchExecutionCaps.js';
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

const CURRENT_PLACEHOLDER_CAPS: ExecutionCaps = Object.freeze({
  perTransactionSol: 10,
  projectRolling24hSol: 50,
  globalRolling24hSol: 250,
});

/** Read-only service boundary for the Telegram launch-planning flow. */
export function planInitialLiquidityForLaunch(
  input: InitialLiquidityPlanRequest,
  executionCaps: ExecutionCaps = CURRENT_PLACEHOLDER_CAPS,
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
    const plan = planInitialLiquidity(planningInput);
    const comparisons = compareInitialLiquidityPlans(planningInput);
    const binStepSensitivity = compareLaunchBinSteps(planningInput);
    const executionCapReadiness = assessLaunchExecutionCaps(plan, executionCaps);
    const wideComparison = comparisons
      .filter((candidate) => candidate.fundedRange.totalBins === 69)
      .map((candidate) => ({
        distributionShape: candidate.distributionShape,
        openingCapacityAtOnePctSol: candidate.buyer.averageImpactCapacity.find(
          (point) => point.maxAverageImpactBps === 100,
        )!.maxOrderSol,
        minimumSampledInRangeCapacityAtOnePctSol: Math.min(
          ...candidate.durability.checkpoints
            .filter((point) => point.insideFundedRange)
            .map((point) => point.maxBuyerOrderSol),
        ),
        downsideCoveragePct: candidate.fundedRange.downsidePct * 100,
        upsideCoveragePct: candidate.fundedRange.upsidePct * 100,
      }));
    return {
      status: 'READ_ONLY',
      defaults: DEFAULTS,
      plan,
      comparisons,
      binStepSensitivity,
      executionCapReadiness,
      strategyDecision: {
        selected: 'SPOT_69',
        rationale: [
          'Initial liquidity is permanent and will not rebalance, so range durability is prioritized over maximum opening concentration.',
          'Spot distributes liquidity uniformly instead of becoming thin near the sampled edges like Curve.',
          'Sixty-nine funded bins use nearly the full classic position and provide the widest tested price-discovery range.',
          'BidAsk is reserved for an explicit DCA or edge-liquidity objective; it contributes less liquidity at the opening price.',
          'The provisional 50 bps bin step is a middle trade-off in the modeled 10-200 bps sensitivity set: smaller steps add opening depth but cover less price movement, while larger steps do the reverse.',
        ],
        wideComparison,
        evidenceLimit:
          'Capacity is a virtual contribution estimate from this position at sampled price moves; it excludes other LPs, routing, dynamic fees, and market reaction.',
      },
      blockers: [
        'Project token mint address is still required.',
        'Token decimals must be verified against that mint.',
        'A Standard-pool preset supporting the provisional 50 bps bin step and 30 bps base fee must be verified on the target cluster.',
        'Exact devnet account and transaction costs require unsigned preflight.',
        ...executionCapReadiness.blockers,
        'Execution caps are placeholder policy values and require deliberate treasury approval before any launch.',
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
