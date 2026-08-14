import Decimal from 'decimal.js';

export type MeteoraPriceRounding = 'DOWN' | 'UP' | 'NEAREST';
export type MeteoraPriceRoundingDirection = 'DOWN' | 'UP' | 'EXACT';

export type MeteoraBinPriceInput = {
  intendedPriceQuotePerBase: number;
  baseTokenDecimals: number;
  quoteTokenDecimals: number;
  binStepBps: number;
  rounding: MeteoraPriceRounding;
};

export type MeteoraBinPricePlan = {
  activeBinId: number;
  intendedPriceQuotePerBase: number;
  representedPriceQuotePerBase: number;
  atomicPriceQuotePerBaseUnit: number;
  roundingDirection: MeteoraPriceRoundingDirection;
  deviationBps: number;
};

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
}

function decimals(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 18) {
    throw new Error(`${label} decimals must be an integer from 0 to 18`);
  }
}

function representedAtomicPrice(binId: number, binStepBps: number): Decimal {
  return new Decimal(1).add(new Decimal(binStepBps).div(10_000)).pow(binId);
}

/**
 * Mirrors the installed DLMM SDK's price/bin conversion without importing the
 * network-capable SDK into the pure planning layer. Human prices must first be
 * converted to atomic-unit prices because token X and token Y can have
 * different decimal counts.
 */
export function planMeteoraBinPrice(input: MeteoraBinPriceInput): MeteoraBinPricePlan {
  positive(input.intendedPriceQuotePerBase, 'intended price');
  decimals(input.baseTokenDecimals, 'base token');
  decimals(input.quoteTokenDecimals, 'quote token');
  if (!Number.isInteger(input.binStepBps) || input.binStepBps <= 0 || input.binStepBps > 10_000) {
    throw new Error('bin step must be an integer from 1 to 10,000 basis points');
  }

  const scale = new Decimal(10).pow(input.quoteTokenDecimals - input.baseTokenDecimals);
  const intended = new Decimal(input.intendedPriceQuotePerBase);
  const intendedAtomic = intended.mul(scale);
  const base = new Decimal(1).add(new Decimal(input.binStepBps).div(10_000));
  const exactBin = intendedAtomic.ln().div(base.ln());
  const lower = exactBin.floor().toNumber();
  const upper = exactBin.ceil().toNumber();
  let activeBinId: number;
  if (input.rounding === 'DOWN') activeBinId = lower;
  else if (input.rounding === 'UP') activeBinId = upper;
  else {
    const lowerDelta = representedAtomicPrice(lower, input.binStepBps).div(intendedAtomic).sub(1).abs();
    const upperDelta = representedAtomicPrice(upper, input.binStepBps).div(intendedAtomic).sub(1).abs();
    activeBinId = lowerDelta.lte(upperDelta) ? lower : upper;
  }
  if (!Number.isSafeInteger(activeBinId)) throw new Error('intended price produces an unsafe active bin id');

  const atomicPrice = representedAtomicPrice(activeBinId, input.binStepBps);
  const represented = atomicPrice.div(scale);
  const comparison = represented.comparedTo(intended);
  return {
    activeBinId,
    intendedPriceQuotePerBase: intended.toNumber(),
    representedPriceQuotePerBase: represented.toNumber(),
    atomicPriceQuotePerBaseUnit: atomicPrice.toNumber(),
    roundingDirection: comparison === 0 ? 'EXACT' : comparison < 0 ? 'DOWN' : 'UP',
    deviationBps: represented.div(intended).sub(1).mul(10_000).toNumber(),
  };
}
