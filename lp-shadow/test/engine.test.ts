/**
 * Fixture-driven tests for the decision engine and the virtual position.
 *
 * Every non-HOLD decision must be explainable from its `reasons` array alone
 * (§15.5), so the reasons are asserted, not just the kind.
 */
import { describe, expect, it } from 'vitest';
import { binPrice, edgeOvershoot, planRange } from '../src/binMath.js';
import { estimateCost } from '../src/decision/costs.js';
import { decide, expectedRecapture7d, positionNavUsd } from '../src/decision/engine.js';
import { sdkExport } from '../src/poller/dlmmSdk.js';
import { isSettled, updateRegime, initRegimeState } from '../src/signals/regime.js';
import { annualizedVol, initVolState, updateVol } from '../src/signals/vol.js';
import {
  creditFullRangeFees,
  initBenchmarks,
  markBenchmarks,
} from '../src/virtual/benchmarks.js';
import {
  accrueFees,
  applyCompound,
  applyExit,
  applyRebalance,
  distributeSpot,
  markPosition,
  openPosition,
  positionValueQuote,
} from '../src/virtual/position.js';
import {
  costInputs,
  HOUR,
  MIN,
  params,
  position,
  signals,
  snapshot,
  T0,
} from './fixtures.js';

const reasonMatching = (reasons: string[], pattern: RegExp): string | undefined =>
  reasons.find((r) => pattern.test(r));

describe('decide — EXIT gate', () => {
  it('exits once volume/TVL has been under the floor for the full dwell', () => {
    const ts = T0;
    const decision = decide(
      snapshot({ ts, poolVol24hUsd: 3_000_000 }),
      position(),
      signals({ volTvl24h: 0.3, volTvlBelowFloorSince: ts - 25 * HOUR }),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('EXIT');
    expect(reasonMatching(decision.reasons, /EXIT gate PASS/)).toMatch(
      /volume\/TVL 0\.300 below floor 0\.500 for 25\.0h \(>= 24\.0h\)/,
    );
    if (decision.kind !== 'EXIT') throw new Error('unreachable');
    expect(decision.costEst.totalUsd).toBeGreaterThan(0);
  });

  it('holds while the dwell clock is still running, and says how far it got', () => {
    const ts = T0;
    const decision = decide(
      snapshot({ ts }),
      position(),
      signals({ volTvl24h: 0.3, volTvlBelowFloorSince: ts - 5 * HOUR }),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /EXIT gate FAIL/)).toMatch(
      /below floor for 5\.0h, needs 24\.0h/,
    );
  });

  it('never starts the exit clock on missing pool stats', () => {
    const decision = decide(
      snapshot({ poolTvlUsd: undefined, poolVol24hUsd: undefined }),
      position(),
      signals({ volTvl24h: null, volTvlBelowFloorSince: null }),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /EXIT gate FAIL/)).toMatch(/unavailable/);
  });
});

describe('decide — REBALANCE gate', () => {
  const oorSnapshot = snapshot({ activeBinId: 1030 });

  it('holds when out of range but the dwell has not elapsed', () => {
    const decision = decide(
      oorSnapshot,
      position({ oorSince: T0 - 10 * MIN }),
      signals(),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /a\. out of range PASS/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /b\. oor dwell FAIL/)).toMatch(
      /10\.0min out of range, needs 30\.0min/,
    );
    // Later gates are still evaluated and reported, so the log shows how close
    // the decision was rather than just where it short-circuited.
    expect(reasonMatching(decision.reasons, /c\. edge overshoot/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /e\. cost coverage/)).toBeDefined();
  });

  it('holds when dwelled but the price has not settled', () => {
    const decision = decide(
      oorSnapshot,
      position({ oorSince: T0 - 45 * MIN }),
      signals({ settled: false }),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /b\. oor dwell PASS/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /d\. settled FAIL/)).toMatch(
      /do not rebalance into a trend/,
    );
  });

  it('holds when the overshoot is too small even after dwelling and settling', () => {
    // bin 1017 is only 2 bins past the upper edge at 1015 -> ~0.40% overshoot.
    const decision = decide(
      snapshot({ activeBinId: 1017 }),
      position({ oorSince: T0 - 45 * MIN }),
      signals(),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /c\. edge overshoot FAIL/)).toMatch(
      /0\.40% past nearest edge, needs 1\.00%/,
    );
  });

  it('holds when every timing gate passes but fees would not repay the cost', () => {
    const decision = decide(
      oorSnapshot,
      position({ oorSince: T0 - 45 * MIN }),
      // A pool earning ~0.1% a year cannot repay a rebalance in a week.
      signals({ poolFeeAprProxy: 0.001 }),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /a\. out of range PASS/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /b\. oor dwell PASS/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /c\. edge overshoot PASS/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /d\. settled PASS/)).toBeDefined();
    expect(reasonMatching(decision.reasons, /e\. cost coverage FAIL/)).toMatch(
      /expected 7d recapture \$0\.13 vs 3\.0x est\. cost/,
    );
    expect(reasonMatching(decision.reasons, /HOLD: closest rebalance gate/)).toMatch(
      /e\. cost coverage/,
    );
  });

  it('holds when the pool fee APR is unknown — an unpriceable gate never fires', () => {
    const decision = decide(
      oorSnapshot,
      position({ oorSince: T0 - 45 * MIN }),
      signals({ poolFeeAprProxy: null }),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /e\. cost coverage FAIL/)).toMatch(
      /pool fee APR unavailable/,
    );
  });

  it('rebalances when all five gates pass, centred on the active bin', () => {
    const decision = decide(
      oorSnapshot,
      position({ oorSince: T0 - 45 * MIN }),
      signals(),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('REBALANCE');
    if (decision.kind !== 'REBALANCE') throw new Error('unreachable');

    // slow vol 60% -> sigma_daily 3.14% -> half-width 4.71% -> 23.6 bins at
    // 20bps, rounded to 24 per side.
    expect(decision.newLowerBin).toBe(1030 - 24);
    expect(decision.newUpperBin).toBe(1030 + 24);
    expect(decision.costEst.totalUsd).toBeGreaterThan(0);
    for (const gate of ['a\\.', 'b\\.', 'c\\.', 'd\\.', 'e\\.']) {
      expect(reasonMatching(decision.reasons, new RegExp(`${gate} .* PASS`))).toBeDefined();
    }
    expect(reasonMatching(decision.reasons, /REBALANCE to bins/)).toMatch(
      /\[1006, 1054\] \(49 bins/,
    );
  });

  it('never rebalances while the position is in range', () => {
    const decision = decide(
      snapshot({ activeBinId: 1000 }),
      position({ oorSince: T0 - 10 * HOUR }),
      signals(),
      params(),
      costInputs(),
    );
    expect(decision.kind).not.toBe('REBALANCE');
    expect(reasonMatching(decision.reasons, /a\. out of range FAIL/)).toMatch(
      /bin 1000 inside \[985, 1015\]/,
    );
  });
});

describe('decide — COMPOUND gate', () => {
  it('compounds once pending fees clear max(min_fees_usd, pct of NAV)', () => {
    const decision = decide(
      snapshot(),
      position({ pendingFeesQuote: 20 }),
      signals(),
      params(),
      costInputs(),
    );

    expect(decision.kind).toBe('COMPOUND');
    if (decision.kind !== 'COMPOUND') throw new Error('unreachable');
    expect(decision.feesQuote).toBe(20);
    expect(reasonMatching(decision.reasons, /COMPOUND gate PASS/)).toMatch(
      /pending fees \$20\.00 >= threshold \$5\.01 \(max of \$5\.00 and 0\.050% of NAV \$10020\.00\)/,
    );
  });

  it('holds just below the threshold — the NAV term includes the pending fees', () => {
    // NAV 10_000 + 5 pending -> 0.05% of NAV is 5.0025, so exactly 5 is short.
    const decision = decide(
      snapshot(),
      position({ pendingFeesQuote: 5 }),
      signals(),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /COMPOUND gate FAIL/)).toMatch(
      /\$5\.00 < threshold \$5\.00/,
    );
    expect(reasonMatching(decision.reasons, /of fees to go before COMPOUND/)).toBeDefined();
  });

  it('uses the percent-of-NAV threshold when it dominates the flat floor', () => {
    const decision = decide(
      snapshot(),
      position({ ...openPosition(snapshot(), 985, 1015, 100_000), pendingFeesQuote: 30 }),
      signals(),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('HOLD');
    // 0.05% of ~100k is ~$50, well above the $5 floor.
    expect(reasonMatching(decision.reasons, /COMPOUND gate FAIL/)).toMatch(
      /\$30\.00 < threshold \$50\.02/,
    );
  });

  it('does not compound while out of range — nothing is accruing there', () => {
    const decision = decide(
      snapshot({ activeBinId: 1030 }),
      position({ pendingFeesQuote: 500, oorSince: T0 - 5 * MIN }),
      signals(),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('HOLD');
    expect(reasonMatching(decision.reasons, /COMPOUND gate FAIL/)).toMatch(
      /out of range, nothing is accruing/,
    );
  });
});

describe('decide — precedence and terminal state', () => {
  it('EXIT wins over a fully-armed REBALANCE', () => {
    const decision = decide(
      snapshot({ activeBinId: 1030 }),
      position({ oorSince: T0 - 45 * MIN }),
      signals({ volTvl24h: 0.1, volTvlBelowFloorSince: T0 - 30 * HOUR }),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('EXIT');
  });

  it('REBALANCE wins over a fully-armed COMPOUND', () => {
    const decision = decide(
      snapshot({ activeBinId: 1030 }),
      position({ oorSince: T0 - 45 * MIN, pendingFeesQuote: 900 }),
      signals(),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('REBALANCE');
  });

  it('an exited position holds forever and says why', () => {
    const decision = decide(
      snapshot(),
      position({ status: 'EXITED', pendingFeesQuote: 5_000 }),
      signals({ volTvl24h: 0.1, volTvlBelowFloorSince: T0 - 90 * HOUR }),
      params(),
      costInputs(),
    );
    expect(decision.kind).toBe('HOLD');
    expect(decision.reasons).toEqual([
      'position EXITED: strategy is stopped, benchmarks keep marking',
    ]);
  });
});

describe('range width rule', () => {
  it('scales the half-width with slow vol', () => {
    const quiet = planRange(1000, 20, signals({ volSlowAnnual: 0.2 }), params());
    const wild = planRange(1000, 20, signals({ volSlowAnnual: 1.2 }), params());
    expect(wild.binsPerSide).toBeGreaterThan(quiet.binsPerSide);
  });

  it('clamps to min_total_bins in dead-quiet markets', () => {
    const plan = planRange(1000, 20, signals({ volSlowAnnual: 0.001 }), params());
    expect(plan.binsPerSide).toBe(Math.ceil(15 / 2));
    expect(plan.upperBinId - plan.lowerBinId + 1).toBeGreaterThanOrEqual(15);
  });

  it('clamps to max_total_bins in chaos, staying under the SDK per-position limit', () => {
    const plan = planRange(1000, 20, signals({ volSlowAnnual: 12 }), params());
    expect(plan.binsPerSide).toBe(Math.floor(69 / 2));
    expect(plan.upperBinId - plan.lowerBinId + 1).toBeLessThanOrEqual(69);
    expect(plan.requestedHalfWidthPct).toBeGreaterThan(plan.halfWidthPct);
  });

  it('ignores fast vol', () => {
    const a = planRange(1000, 20, signals({ volFastAnnual: 0.1 }), params());
    const b = planRange(1000, 20, signals({ volFastAnnual: 5 }), params());
    expect(a.binsPerSide).toBe(b.binsPerSide);
  });
});

describe('cost estimator', () => {
  it('reads the swap cost off the quote rather than the slippage tolerance', () => {
    const est = estimateCost(
      'REBALANCE',
      costInputs({ swapNotionalUsd: 5_000, swapOutValueUsd: 4_980 }),
      params(),
    );
    expect(est.slippageUsd).toBeCloseTo(20, 6);
  });

  it('falls back to price impact, then to the tolerance, when the quote is missing', () => {
    const viaImpact = estimateCost(
      'REBALANCE',
      costInputs({ swapOutValueUsd: null, quotePriceImpactPct: 0.002 }),
      params(),
    );
    expect(viaImpact.slippageUsd).toBeCloseTo(10, 6);

    const viaTolerance = estimateCost(
      'REBALANCE',
      costInputs({ swapOutValueUsd: null, quotePriceImpactPct: null }),
      params(),
    );
    // 50 bps of $5,000 — a broken quote endpoint makes rebalancing look
    // expensive, never free.
    expect(viaTolerance.slippageUsd).toBeCloseTo(25, 6);
  });

  it('charges no swap cost and no bin-array rent for a compound', () => {
    const est = estimateCost('COMPOUND', costInputs({ newBinArrayRentLamports: 1e8 }), params());
    expect(est.slippageUsd).toBe(0);
    expect(est.rentDeltaUsd).toBe(0);
    expect(est.totalUsd).toBeCloseTo(est.priorityFeeUsd + est.txFeesUsd, 12);
  });

  it('charges sunk bin-array rent on a rebalance', () => {
    const withRent = estimateCost(
      'REBALANCE',
      costInputs({ newBinArrayRentLamports: 71_437_440 }),
      params(),
    );
    const withoutRent = estimateCost('REBALANCE', costInputs(), params());
    // 0.07143744 SOL at $150.
    expect(withRent.rentDeltaUsd).toBeCloseTo(10.7156, 3);
    expect(withRent.totalUsd - withoutRent.totalUsd).toBeCloseTo(10.7156, 3);
  });

  it('prices priority fees off compute units and the live estimate', () => {
    const est = estimateCost('REBALANCE', costInputs(), params());
    // 4 tx * 400k CU * 20k microLamports/CU = 32,000 lamports = 3.2e-5 SOL.
    expect(est.priorityFeeUsd).toBeCloseTo(3.2e-5 * 150, 9);
    expect(est.txFeesUsd).toBeCloseTo((4 * 5000) / 1e9 * 150, 9);
  });
});

describe('expected recapture', () => {
  it('is null when the pool fee APR is unknown', () => {
    expect(expectedRecapture7d(10_000, signals({ poolFeeAprProxy: null }), params())).toBeNull();
  });

  it('discounts by the assumed in-range share', () => {
    const full = expectedRecapture7d(10_000, signals(), params({ inRangeShareEstimate: 1 }))!;
    const partial = expectedRecapture7d(10_000, signals(), params({ inRangeShareEstimate: 0.5 }))!;
    expect(partial).toBeCloseTo(full / 2, 9);
  });
});

describe('virtual position mechanics', () => {
  it('opens marked at exactly the deployed NAV', () => {
    const pos = openPosition(snapshot(), 985, 1015, 10_000);
    expect(positionValueQuote(pos, 150)).toBeCloseTo(10_000, 6);
    expect(pos.bins).toHaveLength(31);
  });

  it('matches the SDK spot distribution bin-for-bin', () => {
    const calculateSpotDistribution = sdkExport<
      (
        activeBin: number,
        binIds: number[],
      ) => {
        binId: number;
        xAmountBpsOfTotal: { toNumber(): number };
        yAmountBpsOfTotal: { toNumber(): number };
      }[]
    >('calculateSpotDistribution');

    const binIds: number[] = [];
    for (let id = 995; id <= 1005; id++) binIds.push(id);
    const expected = calculateSpotDistribution(1000, binIds);

    const ours = distributeSpot(995, 1005, 1000, 150, 11_000);
    const totalBase = ours.reduce((sum, bin) => sum + bin.base, 0);
    const totalQuote = ours.reduce((sum, bin) => sum + bin.quote, 0);

    for (const [index, bin] of ours.entries()) {
      const ref = expected[index]!;
      expect(bin.binId).toBe(ref.binId);
      // The SDK rounds to whole bps and sweeps the remainder into the active
      // bin, so allow a couple of bps rather than demanding bit-equality.
      expect(Math.abs((bin.base / totalBase) * 10_000 - ref.xAmountBpsOfTotal.toNumber())).toBeLessThan(2);
      expect(Math.abs((bin.quote / totalQuote) * 10_000 - ref.yAmountBpsOfTotal.toNumber())).toBeLessThan(2);
    }
  });

  it('converts each crossed bin at that bin price, producing impermanent loss', () => {
    const open = snapshot();
    const pos = openPosition(open, 985, 1015, 10_000);
    const hodl = initBenchmarks(open, 10_000);

    // Price runs to the top of the range.
    const upper = snapshot({ activeBinId: 1015, activePrice: binPrice(1015, 1000, 150, 20) });
    const marked = markPosition(pos, upper);

    const lpValue = positionValueQuote(marked, upper.activePrice);
    const hodlValue = markBenchmarks(hodl, marked, upper).hodlNavUsd;

    expect(hodlValue).toBeGreaterThan(10_000);
    // The LP sold base into the rally, so it lags HODL — that gap is the thing
    // fees have to out-earn.
    expect(lpValue).toBeLessThan(hodlValue);
    expect(lpValue).toBeGreaterThan(10_000);
    // Everything below the active bin is quote now.
    expect(marked.bins.filter((b) => b.binId < 1015).every((b) => b.base === 0)).toBe(true);
  });

  it('opens the out-of-range clock and closes it again', () => {
    const pos = openPosition(snapshot(), 985, 1015, 10_000);
    const out = markPosition(pos, snapshot({ ts: T0 + MIN, activeBinId: 1030 }));
    expect(out.oorSince).toBe(T0 + MIN);

    const stillOut = markPosition(out, snapshot({ ts: T0 + 10 * MIN, activeBinId: 1040 }));
    expect(stillOut.oorSince).toBe(T0 + MIN);

    const backIn = markPosition(stillOut, snapshot({ ts: T0 + 20 * MIN, activeBinId: 1000 }));
    expect(backIn.oorSince).toBeNull();
  });

  it('accrues only our diluted share of the active bin, and only in range', () => {
    const snap = snapshot({ liqActiveBin: 1_000, poolFeesIntervalUsd: 100 });
    const pos = openPosition(snap, 999, 1001, 3_000); // $1,000 per bin
    const { position: after, share, feesTick } = accrueFees(pos, snap);

    // Our $1,000 joins a $1,000 bin, so we take half of the interval's fees.
    expect(share).toBeCloseTo(0.5, 9);
    expect(feesTick).toBeCloseTo(50, 9);
    expect(after.pendingFeesQuote).toBeCloseTo(50, 9);
    expect(after.cumFeesQuote).toBeCloseTo(50, 9);

    const oor = accrueFees(pos, snapshot({ ...snap, activeBinId: 1030 }));
    expect(oor.feesTick).toBe(0);
    expect(oor.position.pendingFeesQuote).toBe(0);
  });

  it('folds fees back in on COMPOUND and charges the cost', () => {
    const snap = snapshot();
    const pos = { ...openPosition(snap, 985, 1015, 10_000), pendingFeesQuote: 40 };
    const cost = estimateCost('COMPOUND', costInputs(), params());
    const after = applyCompound(pos, snap, cost);

    expect(after.pendingFeesQuote).toBe(0);
    expect(after.cumCostsQuote).toBeCloseTo(cost.totalUsd, 9);
    expect(positionValueQuote(after, snap.activePrice)).toBeCloseTo(10_040 - cost.totalUsd, 6);
    expect(after.lowerBinId).toBe(985);
  });

  it('redeploys the full remainder into the new range on REBALANCE', () => {
    const snap = snapshot({ activeBinId: 1030 });
    const pos = markPosition(openPosition(snapshot(), 985, 1015, 10_000), snap);
    const before = positionValueQuote(pos, snap.activePrice);
    const cost = estimateCost('REBALANCE', costInputs(), params());
    const after = applyRebalance(pos, snap, 1006, 1054, cost);

    expect(after.lowerBinId).toBe(1006);
    expect(after.upperBinId).toBe(1054);
    expect(after.oorSince).toBeNull();
    expect(after.lastRebalanceAt).toBe(snap.ts);
    expect(positionValueQuote(after, snap.activePrice)).toBeCloseTo(before - cost.totalUsd, 6);
  });

  it('exits to a 50/50 basket and stops', () => {
    const snap = snapshot();
    const pos = openPosition(snap, 985, 1015, 10_000);
    const cost = estimateCost('EXIT', costInputs(), params());
    const after = applyExit(pos, snap, cost);

    expect(after.status).toBe('EXITED');
    expect(after.bins).toHaveLength(0);
    expect(after.base * snap.activePrice).toBeCloseTo(after.quote, 6);
    expect(positionValueQuote(after, snap.activePrice)).toBeCloseTo(10_000 - cost.totalUsd, 6);
  });
});

describe('benchmarks', () => {
  it('seeds HODL and the full-range proxy at the same NAV as the strategy', () => {
    const snap = snapshot();
    const state = initBenchmarks(snap, 10_000);
    const marks = markBenchmarks(state, openPosition(snap, 985, 1015, 10_000), snap);
    expect(marks.hodlNavUsd).toBeCloseTo(10_000, 6);
    expect(marks.fullRangeUsd).toBeCloseTo(10_000, 6);
    expect(marks.strategyUsd).toBeCloseTo(10_000, 6);
  });

  it('marks the full-range proxy as V0 * sqrt(p/p0)', () => {
    const state = initBenchmarks(snapshot(), 10_000);
    const doubled = snapshot({ activePrice: 300 });
    const marks = markBenchmarks(state, openPosition(snapshot(), 985, 1015, 10_000), doubled);
    expect(marks.fullRangeUsd).toBeCloseTo(10_000 * Math.SQRT2, 6);
    // HODL of a 50/50 basket beats the constant-product LP on a doubling.
    expect(marks.hodlNavUsd).toBeCloseTo(15_000, 6);
  });

  it('credits the full-range proxy its share of pool fees', () => {
    const snap = snapshot({ poolTvlUsd: 1_000_000, poolFeesIntervalUsd: 1_000 });
    const state = creditFullRangeFees(initBenchmarks(snap, 10_000), snap);
    // 10k of a 1M pool is 1% of the fees.
    expect(state.fullRangeFees).toBeCloseTo(10, 6);
  });
});

describe('volatility and regime signals', () => {
  it('recovers a known volatility from a synthetic random walk', () => {
    // Alternating +/-0.2% moves every 60s -> 0.002 per sqrt(60s).
    let state = initVolState();
    let price = 150;
    for (let i = 0; i < 4_000; i++) {
      price *= i % 2 === 0 ? 1.002 : 1 / 1.002;
      state = updateVol(state, T0 + i * 60_000, price, 30 * 60);
    }
    const perSecondVar = 0.002 ** 2 / 60;
    const expected = Math.sqrt(perSecondVar * 365 * 24 * 3600);
    expect(annualizedVol(state)).toBeCloseTo(expected, 2);
  });

  it('weights a long gap more than a short one', () => {
    const short = updateVol(
      updateVol(initVolState(), T0, 150, 1800),
      T0 + 45_000,
      151,
      1800,
    );
    const long = updateVol(
      updateVol(initVolState(), T0, 150, 1800),
      T0 + 45_000 * 10,
      151,
      1800,
    );
    // Same move over 10x the time is a lower variance rate.
    expect(annualizedVol(long)).toBeLessThan(annualizedVol(short));
  });

  it('needs a full settle window before calling the price settled', () => {
    const p = params();
    const tight = Array.from({ length: 40 }, (_, i) => ({
      ts: T0 - 20 * MIN + i * 30_000,
      price: 150 + (i % 2) * 0.05,
    }));
    expect(isSettled(tight, T0, p)).toBe(true);

    const tooShort = tight.filter((point) => point.ts >= T0 - 5 * MIN);
    expect(isSettled(tooShort, T0, p)).toBe(false);

    const running = tight.map((point, i) => ({ ts: point.ts, price: 150 + i * 0.5 }));
    expect(isSettled(running, T0, p)).toBe(false);
  });

  it('starts and clears the volume/TVL exit clock', () => {
    const p = params();
    let state = initRegimeState();

    const healthy = updateRegime(state, snapshot({ ts: T0 }), p);
    expect(healthy.signals.volTvlBelowFloorSince).toBeNull();

    const sick = updateRegime(
      healthy.state,
      snapshot({ ts: T0 + MIN, poolVol24hUsd: 1_000_000 }),
      p,
    );
    expect(sick.signals.volTvl24h).toBeCloseTo(0.1, 9);
    expect(sick.signals.volTvlBelowFloorSince).toBe(T0 + MIN);

    const stillSick = updateRegime(
      sick.state,
      snapshot({ ts: T0 + 2 * MIN, poolVol24hUsd: 1_000_000 }),
      p,
    );
    expect(stillSick.signals.volTvlBelowFloorSince).toBe(T0 + MIN);

    const recovered = updateRegime(stillSick.state, snapshot({ ts: T0 + 3 * MIN }), p);
    expect(recovered.signals.volTvlBelowFloorSince).toBeNull();

    state = recovered.state;
    expect(state.volTvlBelowFloorSince).toBeNull();
  });

  it('marks vol unreliable until enough samples have accumulated', () => {
    let state = initRegimeState();
    let signalsOut = updateRegime(state, snapshot({ ts: T0 }), params()).signals;
    expect(signalsOut.volReliable).toBe(false);

    for (let i = 1; i <= 25; i++) {
      const result = updateRegime(
        state,
        snapshot({ ts: T0 + i * 45_000, activePrice: 150 + i * 0.01 }),
        params(),
      );
      state = result.state;
      signalsOut = result.signals;
    }
    expect(signalsOut.volReliable).toBe(true);
  });
});

describe('bin math', () => {
  it('prices bins geometrically off the active bin', () => {
    expect(binPrice(1000, 1000, 150, 20)).toBeCloseTo(150, 9);
    expect(binPrice(1001, 1000, 150, 20)).toBeCloseTo(150 * 1.002, 9);
    expect(binPrice(999, 1000, 150, 20)).toBeCloseTo(150 / 1.002, 9);
  });

  it('reports zero overshoot while in range', () => {
    expect(edgeOvershoot(snapshot({ activeBinId: 1000 }), 985, 1015)).toBe(0);
  });

  it('measures overshoot against the nearest edge on both sides', () => {
    const above = edgeOvershoot(snapshot({ activeBinId: 1030 }), 985, 1015);
    const below = edgeOvershoot(snapshot({ activeBinId: 970 }), 985, 1015);
    expect(above).toBeGreaterThan(0.03);
    expect(below).toBeGreaterThan(0.02);
  });
});

describe('NAV accounting', () => {
  it('counts pending fees toward NAV', () => {
    const snap = snapshot();
    const pos = position({ pendingFeesQuote: 123 });
    expect(positionNavUsd(pos, snap)).toBeCloseTo(
      positionValueQuote(pos, snap.activePrice) + 123,
      6,
    );
  });
});
