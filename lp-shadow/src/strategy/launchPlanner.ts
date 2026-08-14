import { binPrice } from '../binMath.js';
import { prepareInitialPrice } from '../pool/initialPrice.js';
import { planMeteoraBinPrice, type MeteoraPriceRoundingDirection } from '../pool/meteoraPrice.js';
import {
  CLASSIC_POSITION_WIDTH,
  centeredFundedRange,
  classicPositionRange,
} from '../positionRange.js';
import type { DistributionShape, PoolSnapshot } from '../types.js';
import {
  buyCapacityAtAverageImpact,
  buyDepthWithinPriceImpact,
  markPosition,
  openPosition,
  simulateBuyerSwap,
} from '../virtual/position.js';
import { estimateInitialLiquidityCost, type InitialLiquidityCostEstimate } from './launchCosts.js';

export const LAUNCH_PLAN_WIDTHS = Object.freeze([15, 31, 51, 69]);
export const BUYER_CAPACITY_IMPACT_BPS = Object.freeze([50, 100, 200, 500]);
export const DURABILITY_PRICE_CHANGES_PCT = Object.freeze([-20, -15, -10, -5, 0, 5, 10, 15, 20]);
export const LAUNCH_PLAN_SHAPES = Object.freeze<DistributionShape[]>([
  'SPOT',
  'CURVE',
  'BID_ASK',
]);

export type LaunchPlanInput = {
  tokenAmount: number;
  solAmount: number;
  tokenSupply: number;
  tokenDecimals: number;
  solPriceUsd: number | null;
  binStepBps: number;
  baseFeeBps: number;
  distributionShape: DistributionShape;
  totalBins: number;
  buyerOrderSol: number;
  maxBuyerImpactBps: number;
  gasReserveSol: number;
};

export type LaunchPricePlan = {
  mode: 'CREATE';
  intendedPriceSolPerToken: number;
  representedPriceSolPerToken: number;
  activeBinId: number;
  roundingDirection: MeteoraPriceRoundingDirection;
  deviationBps: number;
  intendedFdvSol: number;
  intendedFdvUsd: number | null;
  representedFdvSol: number;
  representedFdvUsd: number | null;
  confirmationPhrase: string;
};

export type InitialLiquidityLaunchPlan = {
  distributionShape: DistributionShape;
  price: LaunchPricePlan;
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
  creationCost: InitialLiquidityCostEstimate & {
    knownRequiredAccountRentUsd: number | null;
    minimumWalletSolWithKnownAccountRent: number;
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
    averageImpactCapacity: Array<{
      maxAverageImpactBps: number;
      maxOrderSol: number;
      maxOrderUsd: number | null;
      actualImpactBps: number;
    }>;
  };
  durability: {
    capacityImpactBps: 100;
    checkpoints: Array<{
      requestedPriceChangePct: number;
      representedPriceChangePct: number;
      activeBinId: number;
      insideFundedRange: boolean;
      maxBuyerOrderSol: number;
      maxBuyerOrderUsd: number | null;
    }>;
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

function validateInput(input: LaunchPlanInput): void {
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
}

function usd(valueSol: number, solPriceUsd: number | null): number | null {
  return solPriceUsd === null ? null : valueSol * solPriceUsd;
}

/**
 * Turns real founder inputs into a read-only opening plan. The supplied token
 * and SOL amounts define the intended opening price. Meteora's representable
 * bin price is then used for all ranges and buyer simulations, without an
 * invented swap or a hidden bin-zero assumption.
 */
export function planInitialLiquidity(input: LaunchPlanInput): InitialLiquidityLaunchPlan {
  validateInput(input);
  const intended = prepareInitialPrice({
    tokenAmount: input.tokenAmount,
    solAmount: input.solAmount,
    tokenSupply: input.tokenSupply,
    solPriceUsd: input.solPriceUsd,
    existingPoolPriceSol: null,
  });
  const represented = planMeteoraBinPrice({
    intendedPriceQuotePerBase: intended.priceSolPerToken,
    baseTokenDecimals: input.tokenDecimals,
    quoteTokenDecimals: 9,
    binStepBps: input.binStepBps,
    rounding: 'NEAREST',
  });
  const displayPrice = Number(represented.representedPriceQuotePerBase.toPrecision(12)).toString();
  const representedFdvSol = represented.representedPriceQuotePerBase * input.tokenSupply;
  const price: LaunchPricePlan = {
    mode: 'CREATE',
    intendedPriceSolPerToken: intended.priceSolPerToken,
    representedPriceSolPerToken: represented.representedPriceQuotePerBase,
    activeBinId: represented.activeBinId,
    roundingDirection: represented.roundingDirection,
    deviationBps: represented.deviationBps,
    intendedFdvSol: intended.impliedFdvSol,
    intendedFdvUsd: intended.impliedFdvUsd,
    representedFdvSol,
    representedFdvUsd: usd(representedFdvSol, input.solPriceUsd),
    confirmationPhrase: `CONFIRM PRICE ${displayPrice} SOL`,
  };
  const activeBinId = price.activeBinId;
  const positionAccount = classicPositionRange(activeBinId);
  const fundedRange = centeredFundedRange(activeBinId, input.totalBins);
  const fundedLower = fundedRange.lowerBinId;
  const fundedUpper = fundedRange.upperBinId;
  const cost = estimateInitialLiquidityCost(
    positionAccount.lowerBinId,
    positionAccount.upperBinId,
  );

  const lowerPrice = binPrice(
    fundedLower,
    activeBinId,
    price.representedPriceSolPerToken,
    input.binStepBps,
  );
  const upperPrice = binPrice(
    fundedUpper,
    activeBinId,
    price.representedPriceSolPerToken,
    input.binStepBps,
  );
  const tokenValueSol = input.tokenAmount * price.representedPriceSolPerToken;
  const initialLiquidityValueSol = tokenValueSol + input.solAmount;
  const snapshot: PoolSnapshot = {
    ts: 0,
    activeBinId,
    activePrice: price.representedPriceSolPerToken,
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
    {
      deployedBaseShare: tokenValueSol / initialLiquidityValueSol,
      deployedQuoteShare: input.solAmount / initialLiquidityValueSol,
    },
  );
  const buyer = simulateBuyerSwap(position, snapshot, input.buyerOrderSol);
  const depthWithinImpactSol = buyDepthWithinPriceImpact(
    position,
    snapshot,
    input.maxBuyerImpactBps,
  );
  const estimatedBaseFeeSol = buyer.filledQuoteUsd * input.baseFeeBps / 10_000;
  const capacityImpactLimits = [...new Set([
    ...BUYER_CAPACITY_IMPACT_BPS,
    input.maxBuyerImpactBps,
  ])].sort((a, b) => a - b);
  const averageImpactCapacity = capacityImpactLimits.map((maxAverageImpactBps) => {
    const capacity = buyCapacityAtAverageImpact(position, snapshot, maxAverageImpactBps);
    return {
      maxAverageImpactBps,
      maxOrderSol: capacity.maxOrderQuote,
      maxOrderUsd: usd(capacity.maxOrderQuote, input.solPriceUsd),
      actualImpactBps: capacity.actualImpactBps,
    };
  });
  const binFactor = 1 + input.binStepBps / 10_000;
  const durabilityCheckpoints = DURABILITY_PRICE_CHANGES_PCT.map((requestedPriceChangePct) => {
    const targetFactor = 1 + requestedPriceChangePct / 100;
    const binDelta = Math.round(Math.log(targetFactor) / Math.log(binFactor));
    const shiftedActiveBinId = activeBinId + binDelta;
    const shiftedPrice = price.representedPriceSolPerToken * binFactor ** binDelta;
    const shiftedSnapshot: PoolSnapshot = {
      ...snapshot,
      activeBinId: shiftedActiveBinId,
      activePrice: shiftedPrice,
    };
    const shiftedPosition = markPosition(position, shiftedSnapshot);
    const capacity = buyCapacityAtAverageImpact(shiftedPosition, shiftedSnapshot, 100);
    return {
      requestedPriceChangePct,
      representedPriceChangePct:
        (shiftedPrice / price.representedPriceSolPerToken - 1) * 100,
      activeBinId: shiftedActiveBinId,
      insideFundedRange:
        shiftedActiveBinId >= fundedLower && shiftedActiveBinId <= fundedUpper,
      maxBuyerOrderSol: capacity.maxOrderQuote,
      maxBuyerOrderUsd: usd(capacity.maxOrderQuote, input.solPriceUsd),
    };
  });

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
      downsidePct: 1 - lowerPrice / price.representedPriceSolPerToken,
      upsidePct: upperPrice / price.representedPriceSolPerToken - 1,
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
    creationCost: {
      ...cost,
      knownRequiredAccountRentUsd: usd(cost.knownRequiredAccountRentSol, input.solPriceUsd),
      minimumWalletSolWithKnownAccountRent:
        input.solAmount + input.gasReserveSol + cost.knownRequiredAccountRentSol,
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
      averageImpactCapacity,
    },
    durability: {
      capacityImpactBps: 100,
      checkpoints: durabilityCheckpoints,
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
