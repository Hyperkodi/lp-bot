import { describe, expect, it } from 'vitest';
import { loadRawConfig, toParams } from '../src/config.js';
import { runVariant, type StoredSnapshot } from '../src/replay/replay.js';
import {
  evaluateProfiles,
  profileVariants,
  rebinSnapshots,
  syntheticStrategyScenarios,
} from '../src/strategy/lab.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import { sdkExport } from '../src/poller/dlmmSdk.js';
import type { CostInputs, DistributionShape, PoolSnapshot } from '../src/types.js';
import {
  buyDepthWithinPriceImpact,
  distributeByShape,
  markPosition,
  openPosition,
  positionValueQuote,
  simulateBuyerSwap,
} from '../src/virtual/position.js';

const baseline = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);

function value(bins: ReturnType<typeof distributeByShape>, price: number) {
  return bins.reduce((total, bin) => total + bin.quote + bin.base * price, 0);
}

describe('strategy distribution simulation', () => {
  it('conserves opening NAV and distinguishes middle-heavy, even, and edge-heavy shapes', () => {
    const spot = distributeByShape(965, 1034, 1000, 100, 10_000, 'SPOT');
    const curve = distributeByShape(965, 1034, 1000, 100, 10_000, 'CURVE');
    const bidAsk = distributeByShape(965, 1034, 1000, 100, 10_000, 'BID_ASK');
    const at = (bins: typeof spot, binId: number) => bins.find((bin) => bin.binId === binId)!;
    const binValue = (bins: typeof spot, binId: number) => {
      const bin = at(bins, binId);
      return bin.quote + bin.base * 100;
    };

    expect(value(spot, 100)).toBeCloseTo(10_000, 8);
    expect(value(curve, 100)).toBeCloseTo(10_000, 8);
    expect(value(bidAsk, 100)).toBeCloseTo(10_000, 8);
    expect(binValue(curve, 1000)).toBeGreaterThan(binValue(spot, 1000));
    expect(binValue(bidAsk, 1000)).toBeLessThan(binValue(spot, 1000));
    expect(binValue(bidAsk, 965)).toBeGreaterThan(binValue(spot, 965));
  });

  it.each<[DistributionShape, string]>([
    ['SPOT', 'calculateSpotDistribution'],
    ['CURVE', 'calculateNormalDistribution'],
    ['BID_ASK', 'calculateBidAskDistribution'],
  ])('matches Meteora SDK token-side weights for %s', (shape, sdkFunction) => {
    type SdkDistribution = {
      binId: number;
      xAmountBpsOfTotal: { toNumber(): number };
      yAmountBpsOfTotal: { toNumber(): number };
    };
    // Use a non-zero active bin. Meteora's standalone weight helper treats a
    // found bin id of 0 as falsy, while the strategy instruction itself uses
    // offsets; comparing away from that SDK helper edge case checks the shape.
    const binIds = [98, 99, 100, 101, 102];
    const sdk = sdkExport<(activeBin: number, ids: number[]) => SdkDistribution[]>(sdkFunction)(
      100,
      binIds,
    );
    const virtual = distributeByShape(98, 102, 100, 100, 10_000, shape);
    const totalBase = virtual.reduce((total, bin) => total + bin.base, 0);
    const totalQuote = virtual.reduce((total, bin) => total + bin.quote, 0);

    for (const expected of sdk) {
      const actual = virtual.find((bin) => bin.binId === expected.binId)!;
      expect((actual.base / totalBase) * 10_000).toBeCloseTo(
        expected.xAmountBpsOfTotal.toNumber(),
        -1,
      );
      expect((actual.quote / totalQuote) * 10_000).toBeCloseTo(
        expected.yAmountBpsOfTotal.toNumber(),
        -1,
      );
    }
  });

  it('keeps an explicit quote reserve outside the bins for defensive inventory', () => {
    const snap = stored(0, {}).snapshot;
    const defensive = openPosition(snap, -10, 10, 10_000, 'BID_ASK', {
      deployedBaseShare: 0.5,
      deployedQuoteShare: 0.15,
    });

    expect(positionValueQuote(defensive, snap.activePrice)).toBeCloseTo(10_000, 8);
    expect(defensive.base * snap.activePrice).toBeCloseTo(5_000, 8);
    expect(defensive.quote).toBeCloseTo(1_500, 8);
    expect(defensive.reserveQuote).toBeCloseTo(3_500, 8);

    const crashed = markPosition(defensive, {
      ...snap,
      activeBinId: -20,
      activePrice: 50,
      ts: snap.ts + 60_000,
    });
    expect(defensive.quote - crashed.quote).toBeLessThanOrEqual(1_500);
    expect(crashed.reserveQuote).toBeCloseTo(3_500, 8);
  });

  it('walks per-bin sell-side liquidity to measure buyer depth, fill, and slippage', () => {
    const snap = stored(0, { activeBinId: 100, activePrice: 100, binStepBps: 25 }).snapshot;
    const position = openPosition(snap, 98, 102, 10_000);
    const smallBuy = simulateBuyerSwap(position, snap, 1_000);
    const oversizedBuy = simulateBuyerSwap(position, snap, 10_000);

    expect(smallBuy.filledQuoteUsd).toBeCloseTo(1_000, 8);
    expect(smallBuy.fillRate).toBeCloseTo(1, 8);
    expect(smallBuy.slippageBps).toBeGreaterThanOrEqual(0);
    expect(oversizedBuy.fillRate).toBeGreaterThan(0);
    expect(oversizedBuy.fillRate).toBeLessThan(1);
    expect(buyDepthWithinPriceImpact(position, snap, 100)).toBeGreaterThan(0);
    expect(buyDepthWithinPriceImpact(position, snap, 100)).toBeLessThanOrEqual(5_100);
  });
});

describe('profile-aware replay inputs', () => {
  it('builds all profiles with their full shape, bin-step, and launch-guard metadata', () => {
    expect(profileVariants(baseline)).toMatchObject([
      {
        profileSlug: 'fee-maximizer',
        distributionShape: 'CURVE',
        defaultBinStepBps: 10,
        launchGuardHours: 24,
        inventoryPolicy: { deployedBaseShare: 0.5, deployedQuoteShare: 0.5 },
      },
      {
        profileSlug: 'market-depth',
        distributionShape: 'SPOT',
        defaultBinStepBps: 25,
        launchGuardHours: 24,
        inventoryPolicy: { deployedBaseShare: 0.5, deployedQuoteShare: 0.5 },
      },
      {
        profileSlug: 'treasury-defensive',
        distributionShape: 'BID_ASK',
        defaultBinStepBps: 50,
        launchGuardHours: 24,
        inventoryPolicy: { deployedBaseShare: 0.5, deployedQuoteShare: 0.15 },
      },
    ]);
  });

  it('maps one price path onto each hypothetical pool bin step without changing prices', () => {
    const source = [100, 101, 99].map((activePrice, index) => stored(index, {
      ts: index * 60_000,
      activePrice,
      activeBinId: index,
      binStepBps: 25,
    }));
    const rebinned = rebinSnapshots(source, 50);

    expect(rebinned.map((row) => row.snapshot.activePrice)).toEqual([100, 101, 99]);
    expect(rebinned.every((row) => row.snapshot.binStepBps === 50)).toBe(true);
    expect(rebinned[1]!.snapshot.activeBinId).toBe(2);
    expect(rebinned[2]!.snapshot.activeBinId).toBe(-2);
  });

  it('records would-be rebalances suppressed by the launch guard', () => {
    const params = {
      ...baseline,
      volMinSamples: 1,
      minTotalBins: 3,
      maxTotalBins: 3,
      widthK: 0.1,
      oorDwellMin: 0,
      edgeOvershootPct: 0,
      settleMin: 0,
      costCoverageMultiple: 0,
      volTvlDwellHours: 999,
    };
    const rows = [
      stored(0, { ts: 0, activePrice: 100, activeBinId: 0 }),
      stored(1, { ts: 60_000, activePrice: 100.01, activeBinId: 0 }),
      stored(2, { ts: 120_000, activePrice: 120, activeBinId: 100 }),
      stored(3, { ts: 180_000, activePrice: 120, activeBinId: 100 }),
    ];
    const result = runVariant(
      {
        name: 'guarded',
        params,
        distributionShape: 'CURVE',
        launchGuardHours: 24,
        poolCreatedAtMs: 0,
      },
      rows,
    );

    expect(result.rebalances).toBe(0);
    expect(result.suppressedRebalances).toBeGreaterThan(0);
    expect(result.events.some((event) => event.kind === 'SUPPRESSED_REBALANCE')).toBe(true);
  });

  it('evaluates every profile across the deterministic stress suite without declaring synthetic data proof', () => {
    const scenarios = syntheticStrategyScenarios();
    const results = evaluateProfiles(baseline, scenarios);

    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      'quiet-market',
      'uptrend',
      'launch-drawdown',
      'volatile-chop',
    ]);
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.evidence === 'SYNTHETIC')).toBe(true);
    for (const result of results) {
      expect(Number.isFinite(result.replay.finalNavUsd)).toBe(true);
      expect(result.replay.maxDrawdownPct).toBeGreaterThanOrEqual(0);
      expect(result.replay.finalBaseSharePct).toBeGreaterThanOrEqual(0);
      expect(result.replay.finalBaseSharePct).toBeLessThanOrEqual(1);
      expect(result.replay.averageBuyDepth1PctUsd).toBeGreaterThanOrEqual(0);
      expect(result.replay.minimumBuyDepth1PctUsd).toBeGreaterThanOrEqual(0);
      expect(result.replay.averageBuyerSlippageBps).toBeGreaterThanOrEqual(0);
      expect(result.replay.buyerOrderFillRate).toBeGreaterThanOrEqual(0);
      expect(result.replay.buyerOrderFillRate).toBeLessThanOrEqual(1);
    }

    const drawdown = results.filter((result) => result.scenario === 'launch-drawdown');
    const marketDepth = drawdown.find((result) => result.profileSlug === 'market-depth')!;
    const defensive = drawdown.find((result) => result.profileSlug === 'treasury-defensive')!;
    expect(defensive.replay.initialQuoteAtRiskUsd).toBe(1_500);
    expect(defensive.replay.cumulativeQuoteConvertedToBaseUsd).toBeLessThan(
      marketDepth.replay.cumulativeQuoteConvertedToBaseUsd,
    );
    expect(defensive.replay.finalReserveQuoteUsd).toBeGreaterThan(0);
  });
});

const costInputs: CostInputs = {
  swapNotionalUsd: 5_000,
  swapOutValueUsd: 4_995,
  quotePriceImpactPct: 0.001,
  priorityFeeMicroLamportsPerCu: 0,
  solPriceUsd: 150,
  newBinArrayRentLamports: 0,
};

function stored(index: number, overrides: Partial<PoolSnapshot>): StoredSnapshot {
  return {
    id: BigInt(index + 1),
    costInputs,
    snapshot: {
      ts: index * 60_000,
      activeBinId: 0,
      activePrice: 100,
      binStepBps: 25,
      feeBps: 30,
      liqActiveBin: 250_000,
      liqNearby: [],
      poolTvlUsd: 1_000_000,
      poolVol24hUsd: 2_000_000,
      poolFees24hUsd: 3_000,
      poolFeesIntervalUsd: 5,
      ...overrides,
    },
  };
}
