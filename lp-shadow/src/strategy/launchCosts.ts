import {
  BIN_ARRAY_RENT_LAMPORTS,
  LAMPORTS_PER_SOL,
  POOL_ACCOUNT_RENT_LAMPORTS,
  POSITION_RENT_LAMPORTS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  binArrayIndex,
} from '../poller/sdkConstants.js';

export type InitialLiquidityCostEstimate = {
  binArrayCount: number;
  poolAccountRentLamports: number;
  reserveTokenAccountRentLamports: number;
  positionAccountRentLamports: number;
  binArrayRentLamports: number;
  knownRequiredAccountRentLamports: number;
  knownRequiredAccountRentSol: number;
  conditionalCreatorTokenAccountRentLamports: number;
  conditionalCreatorTokenAccountRentSol: number;
  transactionFeesIncluded: false;
  priorityFeesIncluded: false;
  bitmapExtensionRentIncluded: false;
  existingAccountCreditsIncluded: false;
};

/**
 * Estimates SDK-published account rent for a brand-new pool and one classic
 * position. It is deliberately not called an all-in quote: creator token
 * accounts, transaction fees, priority fees, optional bitmap extension rent,
 * and any existing-account credits require a network preflight.
 */
export function estimateInitialLiquidityCost(
  lowerPositionBinId: number,
  upperPositionBinId: number,
): InitialLiquidityCostEstimate {
  if (
    !Number.isSafeInteger(lowerPositionBinId) ||
    !Number.isSafeInteger(upperPositionBinId) ||
    lowerPositionBinId > upperPositionBinId
  ) {
    throw new Error('position cost range must contain ordered safe-integer bin ids');
  }
  const binArrayCount =
    binArrayIndex(upperPositionBinId) - binArrayIndex(lowerPositionBinId) + 1;
  const reserveTokenAccountRentLamports = 2 * TOKEN_ACCOUNT_RENT_LAMPORTS;
  const binArrayRentLamports = binArrayCount * BIN_ARRAY_RENT_LAMPORTS;
  const knownRequiredAccountRentLamports =
    POOL_ACCOUNT_RENT_LAMPORTS +
    reserveTokenAccountRentLamports +
    POSITION_RENT_LAMPORTS +
    binArrayRentLamports;
  const conditionalCreatorTokenAccountRentLamports = 2 * TOKEN_ACCOUNT_RENT_LAMPORTS;
  return {
    binArrayCount,
    poolAccountRentLamports: POOL_ACCOUNT_RENT_LAMPORTS,
    reserveTokenAccountRentLamports,
    positionAccountRentLamports: POSITION_RENT_LAMPORTS,
    binArrayRentLamports,
    knownRequiredAccountRentLamports,
    knownRequiredAccountRentSol: knownRequiredAccountRentLamports / LAMPORTS_PER_SOL,
    conditionalCreatorTokenAccountRentLamports,
    conditionalCreatorTokenAccountRentSol:
      conditionalCreatorTokenAccountRentLamports / LAMPORTS_PER_SOL,
    transactionFeesIncluded: false,
    priorityFeesIncluded: false,
    bitmapExtensionRentIncluded: false,
    existingAccountCreditsIncluded: false,
  };
}
