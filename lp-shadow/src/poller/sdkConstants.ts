/**
 * Constants read from the DLMM SDK rather than hardcoded (§15.2).
 *
 * Verified against @meteora-ag/dlmm 1.9.14:
 *   DEFAULT_BIN_PER_POSITION  70      bins in a classic single position
 *   MAX_BINS_PER_POSITION     1400    bins in an extended position
 *   MAX_BIN_ARRAY_SIZE        70      bins per bin-array account
 *   BIN_ARRAY_FEE             0.07143744 SOL  rent for one bin array
 *   POSITION_FEE              0.05740608 SOL  rent for a position account
 *   TOKEN_ACCOUNT_FEE         0.00203928 SOL
 *
 * Phase 1 models one classic position, so `DEFAULT_BIN_PER_POSITION` is the
 * ceiling config is validated against.
 */
import { sdkExport } from './dlmmSdk.js';

function num(name: string): number {
  const value = sdkExport<{ toNumber?: () => number } | number>(name);
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  throw new Error(`DLMM SDK export "${name}" is not numeric — check the SDK version`);
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Bins in a classic (non-extended) position. */
export const BINS_PER_CLASSIC_POSITION = num('DEFAULT_BIN_PER_POSITION');
/** Bins in an extended position; not used by Phase 1, reported for context. */
export const MAX_BINS_PER_POSITION = num('MAX_BINS_PER_POSITION');
/** Bins covered by one bin-array account. */
export const BINS_PER_BIN_ARRAY = num('MAX_BIN_ARRAY_SIZE');

/** Rent, in lamports, of the accounts a position touches. */
export const BIN_ARRAY_RENT_LAMPORTS = Math.round(num('BIN_ARRAY_FEE') * LAMPORTS_PER_SOL);
export const POSITION_RENT_LAMPORTS = Math.round(num('POSITION_FEE') * LAMPORTS_PER_SOL);

/** Bin-array index a bin falls in. Matches `binIdToBinArrayIndex` in the SDK. */
export function binArrayIndex(binId: number): number {
  return Math.floor(binId / BINS_PER_BIN_ARRAY);
}

/**
 * Rent for the bin arrays a range needs that do not already exist.
 *
 * This is the sunk part of a rebalance's cost: position rent comes back when
 * the position closes, bin-array rent does not.
 */
export function newBinArrayRentLamports(
  lowerBinId: number,
  upperBinId: number,
  existingBinArrayIndexes: ReadonlySet<number>,
): number {
  const needed = new Set<number>();
  for (let i = binArrayIndex(lowerBinId); i <= binArrayIndex(upperBinId); i++) {
    if (!existingBinArrayIndexes.has(i)) needed.add(i);
  }
  return needed.size * BIN_ARRAY_RENT_LAMPORTS;
}
