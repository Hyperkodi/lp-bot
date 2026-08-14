/**
 * Replay harness (§11).
 *
 * Re-runs the *pure* engine over stored snapshots with alternate params, writes
 * the results to the `Replay*` table namespace, and prints a comparison table.
 * This is only trustworthy because decision/ and virtual/ are pure: the same
 * snapshot with the same params produces exactly what the live loop produced.
 *
 *   pnpm replay --from 2026-08-01 --params ./config/sweep.toml
 *   pnpm replay --from 2026-08-01 --to 2026-08-08 --label wider-k
 *
 * A sweep file is a TOML table of named variants, each holding dotted-path
 * overrides against config/default.toml:
 *
 *   [variants.baseline]
 *   [variants."k=2.5"]
 *   "position.width_k" = 2.5
 *   [variants.patient]
 *   "rebalance.oor_dwell_min" = 90
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { planRange } from '../binMath.js';
import { applyOverrides, loadEnv, loadRawConfig, toParams, type RawConfig } from '../config.js';
import { estimateCost } from '../decision/costs.js';
import { decide, positionNavUsd } from '../decision/engine.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { disconnectPrisma, getPrisma } from '../ledger/prisma.js';
import { log } from '../logger.js';
import { BINS_PER_CLASSIC_POSITION } from '../poller/sdkConstants.js';
import { initRegimeState, updateRegime } from '../signals/regime.js';
import { applyLaunchGuard } from '../strategy/launchGuard.js';
import type {
  CostInputs,
  DistributionShape,
  InventoryPolicy,
  Params,
  PoolSnapshot,
  VirtualPosition,
} from '../types.js';
import {
  creditFullRangeFees,
  fullRangeValue,
  hodlValue,
  initBenchmarks,
  markBenchmarks,
} from '../virtual/benchmarks.js';
import {
  accrueFees,
  applyCompound,
  applyExit,
  applyRebalance,
  BALANCED_INVENTORY_POLICY,
  buyDepthWithinPriceImpact,
  markPosition,
  openPosition,
  positionValueQuote,
  simulateBuyerSwap,
} from '../virtual/position.js';

type Args = {
  from: Date;
  to: Date;
  paramsFile?: string;
  label?: string;
  /** Which managed pool to replay. Required — replay is always pool-scoped. */
  poolId?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const fromRaw = get('--from');
  const toRaw = get('--to');
  const from = fromRaw ? new Date(fromRaw) : new Date(0);
  const to = toRaw ? new Date(toRaw) : new Date();
  if (Number.isNaN(from.getTime())) throw new Error(`--from is not a date: ${fromRaw}`);
  if (Number.isNaN(to.getTime())) throw new Error(`--to is not a date: ${toRaw}`);
  return {
    from,
    to,
    paramsFile: get('--params'),
    label: get('--label'),
    poolId: get('--pool'),
    dryRun: argv.includes('--dry-run'),
  };
}

export type Variant = {
  name: string;
  params: Params;
  distributionShape?: DistributionShape;
  launchGuardHours?: number;
  poolCreatedAtMs?: number;
  profileSlug?: string;
  defaultBinStepBps?: number;
  inventoryPolicy?: InventoryPolicy;
  /** Replay-only wait from pool creation before opening a position. */
  entryDelayHours?: number;
  /** Anchor HODL/full-range at the first scenario observation while cash waits. */
  benchmarkAtScenarioStart?: boolean;
  /** Replay-only cost charged when converting starting cash into base at entry. */
  entryCostUsd?: number;
  /** Replay-only risk exits. The shipping engine's low-volume exit is separate. */
  explicitExitPolicy?: {
    stopLossPct?: number;
    trailingDrawdownPct?: number;
    maxHoldHours?: number;
    target: 'BALANCED' | 'QUOTE';
  };
};

export function loadVariants(base: RawConfig, paramsFile: string | undefined, label?: string): Variant[] {
  if (!paramsFile) {
    return [{ name: label ?? 'default', params: toParams(base, BINS_PER_CLASSIC_POSITION) }];
  }
  const parsed = parseToml(readFileSync(paramsFile, 'utf8')) as {
    variants?: Record<string, Record<string, unknown>>;
  };
  const variants = parsed.variants;
  if (!variants || Object.keys(variants).length === 0) {
    throw new Error(`${paramsFile} has no [variants.*] tables`);
  }
  return Object.entries(variants).map(([name, overrides]) => ({
    name,
    params: toParams(applyOverrides(base, overrides), BINS_PER_CLASSIC_POSITION),
  }));
}

export type StoredSnapshot = { snapshot: PoolSnapshot; costInputs: CostInputs; id: bigint };

export async function loadSnapshots(
  prisma: PrismaClient,
  managedPoolId: string,
  from: Date,
  to: Date,
): Promise<StoredSnapshot[]> {
  const rows = await prisma.snapshot.findMany({
    where: { managedPoolId, ts: { gte: from, lte: to } },
    orderBy: { ts: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    snapshot: {
      ts: row.ts.getTime(),
      activeBinId: row.activeBinId,
      activePrice: Number(row.activePrice.toString()),
      binStepBps: row.binStepBps,
      feeBps: Number(row.feeBps.toString()),
      liqActiveBin: Number(row.liqActiveBin.toString()),
      liqNearby: (row.liqNearbyJson as { binId: number; liquidity: number }[]) ?? [],
      poolTvlUsd: row.poolTvlUsd === null ? undefined : Number(row.poolTvlUsd.toString()),
      poolVol24hUsd: row.poolVol24hUsd === null ? undefined : Number(row.poolVol24hUsd.toString()),
      poolFees24hUsd:
        row.poolFees24hUsd === null ? undefined : Number(row.poolFees24hUsd.toString()),
      poolFeesIntervalUsd:
        row.poolFeesIntervalUsd === null
          ? undefined
          : Number(row.poolFeesIntervalUsd.toString()),
      jupPrice: row.jupPrice === null ? undefined : Number(row.jupPrice.toString()),
    },
    // Costs are replayed from the inputs that were live at the time, not from
    // today's market — otherwise a sweep would be scored against the wrong book.
    costInputs: (row.costInputsJson as CostInputs | null) ?? {
      swapNotionalUsd: 0,
      swapOutValueUsd: null,
      quotePriceImpactPct: null,
      priorityFeeMicroLamportsPerCu: 0,
      solPriceUsd: 0,
      newBinArrayRentLamports: 0,
    },
  }));
}

export type ReplayResult = {
  variant: string;
  finalNavUsd: number;
  hodlNavUsd: number;
  fullRangeUsd: number;
  netVsHodlUsd: number;
  rebalances: number;
  compounds: number;
  exited: boolean;
  totalCostsUsd: number;
  totalFeesUsd: number;
  timeInRange: number;
  maxDrawdownPct: number;
  finalBaseSharePct: number;
  suppressedRebalances: number;
  averageRangeBins: number;
  initialQuoteAtRiskUsd: number;
  cumulativeQuoteConvertedToBaseUsd: number;
  finalReserveQuoteUsd: number;
  finalReserveSharePct: number;
  buyerOrderUsd: number;
  averageBuyDepth1PctUsd: number;
  minimumBuyDepth1PctUsd: number;
  averageBuyerSlippageBps: number;
  buyerOrderFillRate: number;
  ticks: number;
  events: {
    ts: number;
    snapshotId: bigint;
    kind: string;
    reasons: string[];
    navUsd: number;
    hodlUsd: number;
  }[];
};

/** Pure over its inputs: same snapshots + same params => same result. */
export function runVariant(variant: Variant, stored: StoredSnapshot[]): ReplayResult {
  const params = variant.params;
  if (!Number.isFinite(variant.entryDelayHours ?? 0) || (variant.entryDelayHours ?? 0) < 0) {
    throw new Error('replay entry delay must be finite and non-negative');
  }
  if (!Number.isFinite(variant.entryCostUsd ?? 0) || (variant.entryCostUsd ?? 0) < 0) {
    throw new Error('replay entry cost must be finite and non-negative');
  }
  const explicitExitPolicy = variant.explicitExitPolicy;
  for (const value of [
    explicitExitPolicy?.stopLossPct,
    explicitExitPolicy?.trailingDrawdownPct,
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value >= 1)) {
      throw new Error('replay exit percentages must be between zero and one');
    }
  }
  if (
    explicitExitPolicy?.maxHoldHours !== undefined &&
    (!Number.isFinite(explicitExitPolicy.maxHoldHours) || explicitExitPolicy.maxHoldHours <= 0)
  ) {
    throw new Error('replay maximum hold must be positive');
  }
  let regime = initRegimeState();
  let position: VirtualPosition | null = null;
  let benchmarks = null as ReturnType<typeof initBenchmarks> | null;

  let rebalances = 0;
  let compounds = 0;
  let inRangeTicks = 0;
  let ticks = 0;
  let suppressedRebalances = 0;
  let rangeBinsTotal = 0;
  let peakNavUsd = 0;
  let explicitExitPeakNavUsd = 0;
  let maxDrawdownPct = 0;
  let finalBaseSharePct = 0;
  let cumulativeQuoteConvertedToBaseUsd = 0;
  let finalReserveQuoteUsd = 0;
  let finalReserveSharePct = 0;
  let buyDepth1PctTotal = 0;
  let minimumBuyDepth1PctUsd = Number.POSITIVE_INFINITY;
  let buyerSlippageBpsTotal = 0;
  let buyerSlippageTicks = 0;
  let buyerOrderFillRateTotal = 0;
  const events: ReplayResult['events'] = [];
  let lastMarks = { hodlNavUsd: 0, fullRangeUsd: 0, strategyUsd: 0 };
  const distributionShape = variant.distributionShape ?? 'SPOT';
  const inventoryPolicy = variant.inventoryPolicy ?? BALANCED_INVENTORY_POLICY;
  const poolCreatedAtMs = variant.poolCreatedAtMs ?? stored[0]?.snapshot.ts;
  const buyerOrderUsd = params.virtualNavUsd * 0.1;
  const initialQuoteAtRiskUsd = params.virtualNavUsd * inventoryPolicy.deployedQuoteShare;
  const entryNotBeforeMs =
    poolCreatedAtMs === undefined
      ? Number.NEGATIVE_INFINITY
      : poolCreatedAtMs + (variant.entryDelayHours ?? 0) * 60 * 60_000;

  for (const { snapshot, costInputs, id } of stored) {
    const updated = updateRegime(regime, snapshot, params);
    regime = updated.state;
    const signals = updated.signals;
    let benchmarkCredited = false;

    if (benchmarks === null && variant.benchmarkAtScenarioStart) {
      benchmarks = initBenchmarks(snapshot, params.virtualNavUsd);
    }
    if (benchmarks !== null && variant.benchmarkAtScenarioStart) {
      benchmarks = creditFullRangeFees(benchmarks, snapshot);
      benchmarkCredited = true;
    }

    if (position === null) {
      if (!signals.volReliable || snapshot.ts < entryNotBeforeMs) {
        if (benchmarks) {
          lastMarks = {
            hodlNavUsd: hodlValue(benchmarks, snapshot.activePrice),
            fullRangeUsd:
              fullRangeValue(benchmarks, snapshot.activePrice) + benchmarks.fullRangeFees,
            strategyUsd: params.virtualNavUsd,
          };
        }
        continue;
      }
      const plan = planRange(snapshot.activeBinId, snapshot.binStepBps, signals, params);
      position = openPosition(
        snapshot,
        plan.lowerBinId,
        plan.upperBinId,
        Math.max(0, params.virtualNavUsd - (variant.entryCostUsd ?? 0)),
        distributionShape,
        inventoryPolicy,
      );
      position = {
        ...position,
        cumCostsQuote: position.cumCostsQuote + (variant.entryCostUsd ?? 0),
      };
      benchmarks ??= initBenchmarks(snapshot, params.virtualNavUsd);
    }

    const deployedQuoteBeforeMark = position.quote;
    position = markPosition(position, snapshot);
    cumulativeQuoteConvertedToBaseUsd += Math.max(0, deployedQuoteBeforeMark - position.quote);
    position = accrueFees(position, snapshot).position;
    if (benchmarks && !benchmarkCredited) benchmarks = creditFullRangeFees(benchmarks, snapshot);

    ticks += 1;
    rangeBinsTotal += position.upperBinId - position.lowerBinId + 1;
    if (
      position.status === 'ACTIVE' &&
      snapshot.activeBinId >= position.lowerBinId &&
      snapshot.activeBinId <= position.upperBinId
    ) {
      inRangeTicks += 1;
    }

    const navBeforeDecision = positionNavUsd(position, snapshot);
    explicitExitPeakNavUsd = Math.max(explicitExitPeakNavUsd, navBeforeDecision);
    let explicitExitReason: string | null = null;
    if (position.status === 'ACTIVE' && explicitExitPolicy) {
      if (
        explicitExitPolicy.stopLossPct !== undefined &&
        navBeforeDecision <= params.virtualNavUsd * (1 - explicitExitPolicy.stopLossPct)
      ) {
        explicitExitReason = `stop loss ${(explicitExitPolicy.stopLossPct * 100).toFixed(0)}%`;
      } else if (
        explicitExitPolicy.trailingDrawdownPct !== undefined &&
        explicitExitPeakNavUsd > 0 &&
        navBeforeDecision <= explicitExitPeakNavUsd * (1 - explicitExitPolicy.trailingDrawdownPct)
      ) {
        explicitExitReason =
          `trailing drawdown ${(explicitExitPolicy.trailingDrawdownPct * 100).toFixed(0)}%`;
      } else if (
        explicitExitPolicy.maxHoldHours !== undefined &&
        snapshot.ts - position.openedAt >= explicitExitPolicy.maxHoldHours * 60 * 60_000
      ) {
        explicitExitReason = `maximum hold ${explicitExitPolicy.maxHoldHours}h`;
      }
    }

    const rawDecision = explicitExitReason === null
      ? decide(snapshot, position, signals, params, costInputs)
      : null;
    const guarded = rawDecision === null
      ? null
      : variant.launchGuardHours === undefined || poolCreatedAtMs === undefined
        ? { decision: rawDecision, suppressedDecision: null }
        : applyLaunchGuard(rawDecision, {
            poolCreatedAtMs,
            nowMs: snapshot.ts,
            launchGuardHours: variant.launchGuardHours,
          });
    const decision = guarded?.decision;
    if (guarded?.suppressedDecision?.kind === 'REBALANCE') suppressedRebalances += 1;
    if (explicitExitReason !== null) {
      position = applyExit(
        position,
        snapshot,
        estimateCost('EXIT', costInputs, params),
        explicitExitPolicy!.target,
      );
    } else switch (decision!.kind) {
      case 'COMPOUND':
        position = applyCompound(
          position,
          snapshot,
          estimateCost('COMPOUND', costInputs, params),
          distributionShape,
          inventoryPolicy,
        );
        compounds += 1;
        break;
      case 'REBALANCE':
        position = applyRebalance(
          position,
          snapshot,
          decision!.newLowerBin,
          decision!.newUpperBin,
          decision!.costEst,
          distributionShape,
          inventoryPolicy,
        );
        rebalances += 1;
        break;
      case 'EXIT':
        position = applyExit(position, snapshot, decision!.costEst);
        break;
      case 'HOLD':
        break;
    }

    if (benchmarks) lastMarks = markBenchmarks(benchmarks, position, snapshot);

    const navUsd = positionNavUsd(position, snapshot);
    peakNavUsd = Math.max(peakNavUsd, navUsd);
    if (peakNavUsd > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peakNavUsd - navUsd) / peakNavUsd);
    }
    const inventoryValue = positionValueQuote(position, snapshot.activePrice);
    finalBaseSharePct = inventoryValue > 0
      ? (position.base * snapshot.activePrice) / inventoryValue
      : 0;
    finalReserveQuoteUsd = position.reserveQuote;
    finalReserveSharePct = inventoryValue > 0 ? position.reserveQuote / inventoryValue : 0;

    const buyDepth1PctUsd = buyDepthWithinPriceImpact(position, snapshot, 100);
    const buyerSwap = simulateBuyerSwap(position, snapshot, buyerOrderUsd);
    buyDepth1PctTotal += buyDepth1PctUsd;
    minimumBuyDepth1PctUsd = Math.min(minimumBuyDepth1PctUsd, buyDepth1PctUsd);
    if (buyerSwap.filledQuoteUsd > 0) {
      buyerSlippageBpsTotal += buyerSwap.slippageBps;
      buyerSlippageTicks += 1;
    }
    buyerOrderFillRateTotal += buyerSwap.fillRate;

    if (explicitExitReason !== null) {
      events.push({
        ts: snapshot.ts,
        snapshotId: id,
        kind: 'EXPLICIT_EXIT',
        reasons: [explicitExitReason],
        navUsd,
        hodlUsd: lastMarks.hodlNavUsd,
      });
    } else if (guarded?.suppressedDecision?.kind === 'REBALANCE') {
      events.push({
        ts: snapshot.ts,
        snapshotId: id,
        kind: 'SUPPRESSED_REBALANCE',
        reasons: decision!.reasons,
        navUsd,
        hodlUsd: lastMarks.hodlNavUsd,
      });
    } else if (decision!.kind !== 'HOLD') {
      events.push({
        ts: snapshot.ts,
        snapshotId: id,
        kind: decision!.kind,
        reasons: decision!.reasons,
        navUsd,
        hodlUsd: lastMarks.hodlNavUsd,
      });
    }
  }

  const finalNavUsd = lastMarks.strategyUsd;
  return {
    variant: variant.name,
    finalNavUsd,
    hodlNavUsd: lastMarks.hodlNavUsd,
    fullRangeUsd: lastMarks.fullRangeUsd,
    netVsHodlUsd: finalNavUsd - lastMarks.hodlNavUsd,
    rebalances,
    compounds,
    exited: position?.status === 'EXITED',
    totalCostsUsd: position?.cumCostsQuote ?? 0,
    totalFeesUsd: position?.cumFeesQuote ?? 0,
    timeInRange: ticks > 0 ? inRangeTicks / ticks : 0,
    maxDrawdownPct,
    finalBaseSharePct,
    suppressedRebalances,
    averageRangeBins: ticks > 0 ? rangeBinsTotal / ticks : 0,
    initialQuoteAtRiskUsd,
    cumulativeQuoteConvertedToBaseUsd,
    finalReserveQuoteUsd,
    finalReserveSharePct,
    buyerOrderUsd,
    averageBuyDepth1PctUsd: ticks > 0 ? buyDepth1PctTotal / ticks : 0,
    minimumBuyDepth1PctUsd:
      ticks > 0 && Number.isFinite(minimumBuyDepth1PctUsd) ? minimumBuyDepth1PctUsd : 0,
    averageBuyerSlippageBps:
      buyerSlippageTicks > 0 ? buyerSlippageBpsTotal / buyerSlippageTicks : 0,
    buyerOrderFillRate: ticks > 0 ? buyerOrderFillRateTotal / ticks : 0,
    ticks,
    events,
  };
}

function printTable(results: ReplayResult[]): void {
  const columns: [string, (r: ReplayResult) => string][] = [
    ['variant', (r) => r.variant],
    ['ticks', (r) => String(r.ticks)],
    ['final NAV', (r) => r.finalNavUsd.toFixed(2)],
    ['HODL', (r) => r.hodlNavUsd.toFixed(2)],
    ['net vs HODL', (r) => r.netVsHodlUsd.toFixed(2)],
    ['full-range', (r) => r.fullRangeUsd.toFixed(2)],
    ['fees', (r) => r.totalFeesUsd.toFixed(2)],
    ['costs', (r) => r.totalCostsUsd.toFixed(2)],
    ['rebal', (r) => String(r.rebalances)],
    ['compound', (r) => String(r.compounds)],
    ['in-range', (r) => `${(r.timeInRange * 100).toFixed(1)}%`],
    ['max DD', (r) => `${(r.maxDrawdownPct * 100).toFixed(1)}%`],
    ['base', (r) => `${(r.finalBaseSharePct * 100).toFixed(1)}%`],
    ['reserve', (r) => `${(r.finalReserveSharePct * 100).toFixed(1)}%`],
    ['depth 1%', (r) => r.averageBuyDepth1PctUsd.toFixed(0)],
    ['buy fill', (r) => `${(r.buyerOrderFillRate * 100).toFixed(1)}%`],
    ['buy slip', (r) => `${r.averageBuyerSlippageBps.toFixed(1)}bp`],
    ['guarded', (r) => String(r.suppressedRebalances)],
    ['exited', (r) => (r.exited ? 'yes' : 'no')],
  ];
  const widths = columns.map(([header, get]) =>
    Math.max(header.length, ...results.map((r) => get(r).length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, i) => cell.padStart(widths[i]!)).join('  ');

  process.stdout.write(`${render(columns.map(([h]) => h))}\n`);
  process.stdout.write(`${render(widths.map((w) => '-'.repeat(w)))}\n`);
  for (const result of results) {
    process.stdout.write(`${render(columns.map(([, get]) => get(result)))}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const base = loadRawConfig();
  const prisma = getPrisma(env.DATABASE_URL);

  // Replay is always scoped to one pool: mixing two pools' snapshots would
  // produce a number that describes nothing.
  const pool = args.poolId
    ? await prisma.managedPool.findUnique({ where: { id: args.poolId } })
    : await prisma.managedPool.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!pool) {
    log.error(
      args.poolId
        ? `no managed pool with id ${args.poolId}`
        : 'no managed pools registered — nothing to replay',
    );
    await disconnectPrisma();
    return;
  }
  log.info(`replaying pool ${pool.label} (${pool.poolAddress}) [${pool.id}]`);

  // The pool's own size, not the TOML default — sizing changes the answer.
  const withNav = applyOverrides(base, {
    'pool.address': pool.poolAddress,
    'pool.label': pool.label,
    'position.virtual_nav_usd': Number(pool.virtualNavUsd.toString()),
  });
  const variants = loadVariants(withNav, args.paramsFile, args.label);

  const stored = await loadSnapshots(prisma, pool.id, args.from, args.to);
  log.info(
    `replaying ${stored.length} snapshots from ${args.from.toISOString()} to ` +
      `${args.to.toISOString()} across ${variants.length} variant(s)`,
  );
  if (stored.length === 0) {
    log.warn('no snapshots in range — nothing to replay');
    await disconnectPrisma();
    return;
  }

  const results = variants.map((variant) => runVariant(variant, stored));
  printTable(results);

  if (!args.dryRun) {
    for (const [index, result] of results.entries()) {
      const run = await prisma.replayRun.create({
        data: {
          managedPoolId: pool.id,
          label: args.label ? `${args.label}:${result.variant}` : result.variant,
          fromTs: args.from,
          toTs: args.to,
          paramsJson: variants[index]!.params as unknown as object,
          resultsJson: {
            finalNavUsd: result.finalNavUsd,
            hodlNavUsd: result.hodlNavUsd,
            fullRangeUsd: result.fullRangeUsd,
            netVsHodlUsd: result.netVsHodlUsd,
            rebalances: result.rebalances,
            compounds: result.compounds,
            exited: result.exited,
            totalCostsUsd: result.totalCostsUsd,
            totalFeesUsd: result.totalFeesUsd,
            timeInRange: result.timeInRange,
            maxDrawdownPct: result.maxDrawdownPct,
            finalBaseSharePct: result.finalBaseSharePct,
            suppressedRebalances: result.suppressedRebalances,
            averageRangeBins: result.averageRangeBins,
            ticks: result.ticks,
          },
        },
        select: { id: true },
      });
      if (result.events.length > 0) {
        await prisma.replayEvent.createMany({
          data: result.events.map((event) => ({
            runId: run.id,
            ts: new Date(event.ts),
            snapshotId: event.snapshotId,
            kind: event.kind,
            reasonsJson: event.reasons,
            navUsd: event.navUsd.toFixed(18),
            hodlUsd: event.hodlUsd.toFixed(18),
          })),
        });
      }
    }
    log.info(`wrote ${results.length} replay run(s) to the ledger`);
  }

  await disconnectPrisma();
}

const isEntrypoint = process.argv[1]?.includes('replay');
if (isEntrypoint) {
  main().catch(async (err) => {
    log.error(`replay failed: ${err instanceof Error ? err.message : String(err)}`, err);
    await disconnectPrisma().catch(() => undefined);
    process.exitCode = 1;
  });
}
