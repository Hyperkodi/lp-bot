/** Width of the classic Meteora position used by the execution recipe. */
export const CLASSIC_POSITION_WIDTH = 70;

export function classicPositionRange(activeBinId: number) {
  if (!Number.isSafeInteger(activeBinId)) throw new Error('active bin id must be a safe integer');
  const lowerBinId = activeBinId - Math.floor(CLASSIC_POSITION_WIDTH / 2);
  return {
    lowerBinId,
    upperBinId: lowerBinId + CLASSIC_POSITION_WIDTH - 1,
    width: CLASSIC_POSITION_WIDTH,
  };
}

/**
 * Centres a funded interval inside the classic 70-bin position account.
 * Meteora positions need the full account width even when the strategy funds
 * fewer bins.
 */
export function centeredFundedRange(activeBinId: number, totalBins: number) {
  if (!Number.isSafeInteger(totalBins) || totalBins <= 0 || totalBins > CLASSIC_POSITION_WIDTH) {
    throw new Error(`funded range must contain 1 to ${CLASSIC_POSITION_WIDTH} bins`);
  }
  const position = classicPositionRange(activeBinId);
  const lowerBinId = activeBinId - Math.floor(totalBins / 2);
  const upperBinId = lowerBinId + totalBins - 1;
  if (lowerBinId < position.lowerBinId || upperBinId > position.upperBinId) {
    throw new Error('funded range must stay inside the classic position');
  }
  return { lowerBinId, upperBinId, totalBins };
}
