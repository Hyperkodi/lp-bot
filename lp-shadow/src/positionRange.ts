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
