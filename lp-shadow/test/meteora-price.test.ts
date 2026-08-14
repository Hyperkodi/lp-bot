import { describe, expect, it } from 'vitest';
import { planMeteoraBinPrice } from '../src/pool/index.js';
import { DLMM, sdkExport } from '../src/poller/dlmmSdk.js';

const getPriceOfBinByBinId = sdkExport<(binId: number, binStep: number) => { toString(): string }>(
  'getPriceOfBinByBinId',
);

describe('Meteora initial-price bin conversion', () => {
  it('matches the installed SDK for a token/SOL price with different decimals', () => {
    const plan = planMeteoraBinPrice({
      intendedPriceQuotePerBase: 0.0000132,
      baseTokenDecimals: 6,
      quoteTokenDecimals: 9,
      binStepBps: 50,
      rounding: 'NEAREST',
    });
    const sdkAtomicPrice = DLMM.getPricePerLamport(6, 9, 0.0000132);
    const sdkLower = DLMM.getBinIdFromPrice(sdkAtomicPrice, 50, true);
    const sdkUpper = DLMM.getBinIdFromPrice(sdkAtomicPrice, 50, false);
    const sdkNearest = [sdkLower, sdkUpper].sort((a, b) => {
      const aPrice = Number(getPriceOfBinByBinId(a, 50).toString());
      const bPrice = Number(getPriceOfBinByBinId(b, 50).toString());
      return Math.abs(aPrice / Number(sdkAtomicPrice) - 1) -
        Math.abs(bPrice / Number(sdkAtomicPrice) - 1);
    })[0]!;

    expect(plan.activeBinId).toBe(sdkNearest);
    expect(plan.activeBinId).toBe(-868);
    expect(plan.atomicPriceQuotePerBaseUnit).toBeCloseTo(
      Number(getPriceOfBinByBinId(sdkNearest, 50).toString()),
      15,
    );
    expect(plan.representedPriceQuotePerBase).toBeCloseTo(0.00001317826982110771, 16);
    expect(plan.roundingDirection).toBe('DOWN');
    expect(plan.deviationBps).toBeLessThan(0);
  });

  it('supports explicit lower and upper bin selection and exact bin zero', () => {
    const input = {
      intendedPriceQuotePerBase: 1,
      baseTokenDecimals: 9,
      quoteTokenDecimals: 9,
      binStepBps: 25,
    };
    expect(planMeteoraBinPrice({ ...input, rounding: 'DOWN' })).toMatchObject({
      activeBinId: 0,
      representedPriceQuotePerBase: 1,
      roundingDirection: 'EXACT',
      deviationBps: 0,
    });

    const between = { ...input, intendedPriceQuotePerBase: 1.001, binStepBps: 25 };
    expect(planMeteoraBinPrice({ ...between, rounding: 'DOWN' }).activeBinId).toBe(0);
    expect(planMeteoraBinPrice({ ...between, rounding: 'UP' }).activeBinId).toBe(1);
  });

  it('rejects prices, decimal counts, and bin steps that cannot produce a plan', () => {
    expect(() => planMeteoraBinPrice({
      intendedPriceQuotePerBase: 0,
      baseTokenDecimals: 6,
      quoteTokenDecimals: 9,
      binStepBps: 50,
      rounding: 'NEAREST',
    })).toThrow(/price/i);
    expect(() => planMeteoraBinPrice({
      intendedPriceQuotePerBase: 1,
      baseTokenDecimals: -1,
      quoteTokenDecimals: 9,
      binStepBps: 50,
      rounding: 'NEAREST',
    })).toThrow(/decimals/i);
  });
});
