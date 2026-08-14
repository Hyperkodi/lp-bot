/**
 * The decision engine.
 *
 * PURE: `decide` is a function of its arguments and nothing else. No clock
 * reads, no network, no imports from poller/ledger/report. That is what makes
 * the replay harness (§11) worth trusting — re-running stored snapshots through
 * this function reproduces exactly what the live loop decided.
 */
import { DAYS_PER_YEAR, edgeOvershoot, isInRange, planRange } from '../binMath.js';
import type {
  CostInputs,
  Decision,
  Params,
  PoolSnapshot,
  Signals,
  VirtualPosition,
} from '../types.js';
import { estimateCost } from './costs.js';

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(digits);
}

function pct(n: number, digits = 2): string {
  return `${fmt(n * 100, digits)}%`;
}

/** NAV of the virtual position marked at the snapshot price, incl. pending fees. */
export function positionNavUsd(position: VirtualPosition, snapshot: PoolSnapshot): number {
  return (
    position.base * snapshot.activePrice +
    position.quote +
    position.reserveQuote +
    position.pendingFeesQuote
  );
}

/**
 * Fees we would expect to recapture over the next 7 days from a freshly centred
 * range, used by the rebalance cost-coverage gate.
 *
 * `poolFeeAprProxy` is a *pool-level* APR, so applying it to our NAV understates
 * what a concentrated range would earn. That is deliberate: the gate should be
 * hard to pass, not easy.
 */
export function expectedRecapture7d(
  navUsd: number,
  signals: Signals,
  params: Params,
): number | null {
  if (signals.poolFeeAprProxy === null) return null;
  return (
    signals.poolFeeAprProxy * navUsd * (7 / DAYS_PER_YEAR) * params.inRangeShareEstimate
  );
}

export function decide(
  snapshot: PoolSnapshot,
  position: VirtualPosition,
  signals: Signals,
  params: Params,
  costInputs: CostInputs,
): Decision {
  const reasons: string[] = [];

  if (position.status === 'EXITED') {
    reasons.push('position EXITED: strategy is stopped, benchmarks keep marking');
    return { kind: 'HOLD', reasons };
  }

  // ---- 1. EXIT gate ------------------------------------------------------
  const volTvl = signals.volTvl24h;
  if (signals.volTvlBelowFloorSince !== null) {
    const dwellHours = (snapshot.ts - signals.volTvlBelowFloorSince) / MS_PER_HOUR;
    if (dwellHours >= params.volTvlDwellHours) {
      reasons.push(
        `EXIT gate PASS: volume/TVL ${fmt(volTvl ?? 0, 3)} below floor ` +
          `${fmt(params.volTvlFloor, 3)} for ${fmt(dwellHours, 1)}h ` +
          `(>= ${fmt(params.volTvlDwellHours, 1)}h)`,
      );
      return { kind: 'EXIT', costEst: estimateCost('EXIT', costInputs, params), reasons };
    }
    reasons.push(
      `EXIT gate FAIL: volume/TVL ${fmt(volTvl ?? 0, 3)} below floor for ` +
        `${fmt(dwellHours, 1)}h, needs ${fmt(params.volTvlDwellHours, 1)}h`,
    );
  } else if (volTvl === null) {
    reasons.push('EXIT gate FAIL: volume/TVL unavailable (pool stats API returned nothing)');
  } else {
    reasons.push(
      `EXIT gate FAIL: volume/TVL ${fmt(volTvl, 3)} at or above floor ` +
        `${fmt(params.volTvlFloor, 3)}`,
    );
  }

  const inRange = isInRange(snapshot, position.lowerBinId, position.upperBinId);
  const navUsd = positionNavUsd(position, snapshot);

  // ---- 2. REBALANCE gate -------------------------------------------------
  // Every sub-gate is evaluated and logged even after one fails, so the reasons
  // array shows how close the decision was rather than just where it stopped.
  const gates: { name: string; pass: boolean; detail: string }[] = [];

  gates.push({
    name: 'a. out of range',
    pass: !inRange,
    detail: inRange
      ? `bin ${snapshot.activeBinId} inside [${position.lowerBinId}, ${position.upperBinId}]`
      : `bin ${snapshot.activeBinId} outside [${position.lowerBinId}, ${position.upperBinId}]`,
  });

  const dwellMin =
    position.oorSince === null ? 0 : (snapshot.ts - position.oorSince) / MS_PER_MIN;
  gates.push({
    name: 'b. oor dwell',
    pass: position.oorSince !== null && dwellMin >= params.oorDwellMin,
    detail: `${fmt(dwellMin, 1)}min out of range, needs ${fmt(params.oorDwellMin, 1)}min`,
  });

  const overshoot = edgeOvershoot(snapshot, position.lowerBinId, position.upperBinId);
  gates.push({
    name: 'c. edge overshoot',
    pass: overshoot * 100 >= params.edgeOvershootPct,
    detail: `${pct(overshoot)} past nearest edge, needs ${fmt(params.edgeOvershootPct)}%`,
  });

  gates.push({
    name: 'd. settled',
    pass: signals.settled,
    detail: signals.settled
      ? `price inside +/-${fmt(params.settleBandPct)}% band for ${fmt(params.settleMin)}min`
      : `price still running (not inside +/-${fmt(params.settleBandPct)}% band for ` +
        `${fmt(params.settleMin)}min) — do not rebalance into a trend`,
  });

  const plan = planRange(snapshot.activeBinId, snapshot.binStepBps, signals, params);
  const costEst = estimateCost('REBALANCE', costInputs, params);
  const recapture = expectedRecapture7d(navUsd, signals, params);
  const required = params.costCoverageMultiple * costEst.totalUsd;
  gates.push({
    name: 'e. cost coverage',
    pass: recapture !== null && recapture >= required,
    detail:
      recapture === null
        ? 'pool fee APR unavailable, cannot project recapture'
        : `expected 7d recapture $${fmt(recapture)} vs ${fmt(params.costCoverageMultiple, 1)}x ` +
          `est. cost $${fmt(costEst.totalUsd)} = $${fmt(required)}`,
  });

  const allPass = gates.every((g) => g.pass);
  for (const g of gates) {
    reasons.push(`REBALANCE ${g.name} ${g.pass ? 'PASS' : 'FAIL'}: ${g.detail}`);
  }

  if (allPass) {
    reasons.push(
      `REBALANCE to bins [${plan.lowerBinId}, ${plan.upperBinId}] ` +
        `(${plan.binsPerSide * 2 + 1} bins, half-width ${pct(plan.halfWidthPct)}, ` +
        `slow vol ${pct(signals.volSlowAnnual)} annual, k=${fmt(params.widthK, 2)})`,
    );
    return {
      kind: 'REBALANCE',
      newLowerBin: plan.lowerBinId,
      newUpperBin: plan.upperBinId,
      costEst,
      reasons,
    };
  }

  // ---- 3. COMPOUND gate (only when in range) -----------------------------
  const compoundThreshold = Math.max(params.minFeesUsd, params.minFeesPctNav * navUsd);
  if (!inRange) {
    reasons.push('COMPOUND gate FAIL: position out of range, nothing is accruing');
  } else if (position.pendingFeesQuote >= compoundThreshold) {
    reasons.push(
      `COMPOUND gate PASS: pending fees $${fmt(position.pendingFeesQuote)} >= ` +
        `threshold $${fmt(compoundThreshold)} ` +
        `(max of $${fmt(params.minFeesUsd)} and ${pct(params.minFeesPctNav, 3)} of ` +
        `NAV $${fmt(navUsd)})`,
    );
    return { kind: 'COMPOUND', feesQuote: position.pendingFeesQuote, reasons };
  } else {
    reasons.push(
      `COMPOUND gate FAIL: pending fees $${fmt(position.pendingFeesQuote)} < ` +
        `threshold $${fmt(compoundThreshold)}`,
    );
  }

  // ---- 4. HOLD -----------------------------------------------------------
  const failed = gates.filter((g) => !g.pass);
  if (failed.length > 0) {
    reasons.push(
      `HOLD: closest rebalance gate(s) still open — ${failed.map((g) => g.name).join(', ')}`,
    );
  } else {
    reasons.push('HOLD: no gate fired');
  }
  if (inRange) {
    const remaining = compoundThreshold - position.pendingFeesQuote;
    reasons.push(`HOLD: $${fmt(Math.max(0, remaining))} of fees to go before COMPOUND`);
  }
  return { kind: 'HOLD', reasons };
}
