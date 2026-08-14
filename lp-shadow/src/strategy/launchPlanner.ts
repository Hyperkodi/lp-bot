import { binPrice } from '../binMath.js';
import { prepareInitialPrice, type InitialPriceCeremony } from '../pool/initialPrice.js';
import { CLASSIC_POSITION_WIDTH, classicPositionRange } from '../positionRange.js';
import type { DistributionShape, PoolSnapshot } from '../types.js';
import {
  BALANCED_INVENTORY_POLICY,
  buyDepthWithinPriceImpact,
  openPosition,
  simulateBuyerSwap,
} from '../virtual/position.js';

export const LAUNCH_PLAN_WIDTHS = Object.freeze([15, 31, 51, 69]);
export const LAUNCH_PLAN_SHAPES = Object.freeze<DistributionShape[]>([
  'SPOT',
  'CURVE',
  'BID_ASK',
]);

export type LaunchPlanInput = {
  tokenAmount: number;
  solAmount: number;
  tokenSupply: number;
  solPriceUsd: number | null;
  binStepBps: number;
  baseFeeBps: number;
  distributionShape: DistributionShape;
  totalBins: number;
  buyerOrderSol: number;
  maxBuyerImpactBps: number;
  gasReserveSol: number;
  activeBinId?: number;
};

export type InitialLiquidityLaunchPlan = {
  distributionShape: DistributionShape;
  price: InitialPriceCeremony;
  positionAccount: { lowerBinId: number; upperBinId: number; width: number };
  fundedRange: {
    lowerBinId: number;
    upperBinId: number;
    totalBins: number;
    lowerPriceSolPerToken: number;
    upperPriceSolPerToken: number;
    lowerPriceUsdPerToken: number | null;
    upperPriceUsdPerToken: number | null;
    downsidePct: number;
    upsidePct: number;
  };
  deposit: {
    tokenAmount: number;
    positionSolAmount: number;
    gasReserveSol: number;
    minimumWalletSolBeforeCreationCosts: number;
    creationCostsIncluded: false;
    initialLiquidityValueSol: number;
    initialLiquidityValueUsd: number | null;
  };
  pool: { binStepBps: number; baseFeeBps: number };
  buyer: {
    requestedSol: number;
    requestedUsd: number | null;
    filledSol: number;
    filledUsd: number | null;
    tokenReceived: number;
    averagePriceSolPerToken: number | null;
    priceImpactBps: number;
    fillRate: number;
    depthWithinImpactSol: number;
    depthWithinImpactUsd: number | null;
    estimatedBaseFeeSol: number;
    estimatedBaseFeeUsd: number | null;
  };
  policy: {
    opensAtPoolCreation: true;
    remainsDeposited: true;
    founderWithdrawalAvailable: true;
    compounds: false;
    rebalances: false;
    exits: false;
    laterAdditionsIncluded: false;
  };
};

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function nonNegative(value: number, label: string): void {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative`);
}

function validateInput(input: LaunchPlanInput): number {
  if (!Number.isInteger(input.binStepBps) || input.binStepBps <= 0) {
    throw new Error('bin step must be a positive integer number of basis points');
  }
  if (!Number.isInteger(input.baseFeeBps) || input.baseFeeBps < 0 || input.baseFeeBps > 10_000) {
    throw new Error('base fee must be an integer from 0 to 10,000 basis points');
  }
  if (
    !Number.isInteger(input.totalBins) ||
    input.totalBins <= 0 ||
    input.totalBins > CLASSIC_POSITION_WIDTH
  ) {
    throw new Error(`funded range must fit inside the ${CLASSIC_POSITION_WIDTH}-bin classic position`);
  }
  if (!LAUNCH_PLAN_SHAPES.includes(input.distributionShape)) {
    throw new Error('distribution shape must be SPOT, CURVE, or BID_ASK');
  }
  nonNegative(input.buyerOrderSol, 'buyer order');
  nonNegative(input.maxBuyerImpactBps, 'maximum buyer impact');
  nonNegative(input.gasReserveSol, 'gas reserve');
  const activeBinId = input.activeBinId ?? 0;
  if (!Number.isSafeInteger(activeBinId)) throw new Error('active bin id must be a safe integer');
  return activeBinId;
}

function usd(valueSol: number, solPriceUsd: number | null): number | null {
  return solPriceUsd === null ? null : valueSol * solPriceUsd;
}

/**
 * Turns real founder inputs into a read-only opening plan. The supplied token
 * and SOL amounts define the opening price, so their marked values are equal
 * at creation and both sides can be allocated without an invented swap.
 */
export function planInitialLiquidity(input: LaunchPlanInput): InitialLiquidityLaunchPlan {
  const activeBinId = validateInput(input);
  const price = prepareInitialPrice({
    tokenAmount: input.tokenAmount,
    solAmount: input.solAmount,
    tokenSupply: input.tokenSupply,
    solPriceUsd: input.solPriceUsd,
    existingPoolPriceSol: null,
  });
  const positionAccount = classicPositionRange(activeBinId);
  const fundedLower = activeBinId - Math.floor(input.totalBins / 2);
  const fundedUpper = fundedLower + input.totalBins - 1;
  if (fundedLower < positionAccount.lowerBinId || fundedUpper > positionAccount.upperBinId) {
    throw new Error('funded range must stay inside the 70-bin classic position');
  }

  const lowerPrice = binPrice(
    fundedLower,
    activeBinId,
    price.priceSolPerToken,
    input.binStepBps,
  );
  const upperPrice = binPrice(
    fundedUpper,
    activeBinId,
    price.priceSolPerToken,
    input.binStepBps,
  );
  const initialLiquidityValueSol = input.solAmount * 2;
  const snapshot: PoolSnapshot = {
    ts: 0,
    activeBinId,
    activePrice: price.priceSolPerToken,
    binStepBps: input.binStepBps,
    feeBps: input.baseFeeBps,
    liqActiveBin: 0,
    liqNearby: [],
  };
  const position = openPosition(
    snapshot,
    fundedLower,
    fundedUpper,
    initialLiquidityValueSol,
    input.distributionShape,
    BALANCED_INVENTORY_POLICY,
  );
  const buyer = simulateBuyerSwap(position, snapshot, input.buyerOrderSol);
  const depthWithinImpactSol = buyDepthWithinPriceImpact(
    position,
    snapshot,
    input.maxBuyerImpactBps,
  );
  const estimatedBaseFeeSol = buyer.filledQuoteUsd * input.baseFeeBps / 10_000;

  return {
    distributionShape: input.distributionShape,
    price,
    positionAccount,
    fundedRange: {
      lowerBinId: fundedLower,
      upperBinId: fundedUpper,
      totalBins: input.totalBins,
      lowerPriceSolPerToken: lowerPrice,
      upperPriceSolPerToken: upperPrice,
      lowerPriceUsdPerToken: usd(lowerPrice, input.solPriceUsd),
      upperPriceUsdPerToken: usd(upperPrice, input.solPriceUsd),
      downsidePct: 1 - lowerPrice / price.priceSolPerToken,
      upsidePct: upperPrice / price.priceSolPerToken - 1,
    },
    deposit: {
      tokenAmount: input.tokenAmount,
      positionSolAmount: input.solAmount,
      gasReserveSol: input.gasReserveSol,
      minimumWalletSolBeforeCreationCosts: input.solAmount + input.gasReserveSol,
      creationCostsIncluded: false,
      initialLiquidityValueSol,
      initialLiquidityValueUsd: usd(initialLiquidityValueSol, input.solPriceUsd),
    },
    pool: { binStepBps: input.binStepBps, baseFeeBps: input.baseFeeBps },
    buyer: {
      requestedSol: input.buyerOrderSol,
      requestedUsd: usd(input.buyerOrderSol, input.solPriceUsd),
      filledSol: buyer.filledQuoteUsd,
      filledUsd: usd(buyer.filledQuoteUsd, input.solPriceUsd),
      tokenReceived: buyer.baseReceived,
      averagePriceSolPerToken: buyer.averagePrice,
      priceImpactBps: buyer.slippageBps,
      fillRate: buyer.fillRate,
      depthWithinImpactSol,
      depthWithinImpactUsd: usd(depthWithinImpactSol, input.solPriceUsd),
      estimatedBaseFeeSol,
      estimatedBaseFeeUsd: usd(estimatedBaseFeeSol, input.solPriceUsd),
    },
    policy: {
      opensAtPoolCreation: true,
      remainsDeposited: true,
      founderWithdrawalAvailable: true,
      compounds: false,
      rebalances: false,
      exits: false,
      laterAdditionsIncluded: false,
    },
  };
}

export function compareInitialLiquidityPlans(
  input: LaunchPlanInput,
): InitialLiquidityLaunchPlan[] {
  return LAUNCH_PLAN_SHAPES.flatMap((distributionShape) =>
    LAUNCH_PLAN_WIDTHS.map((totalBins) =>
      planInitialLiquidity({ ...input, distributionShape, totalBins }),
    ),
  );
}
