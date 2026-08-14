/**
 * All database writes. Nothing outside this file talks to Prisma except the
 * replay harness, which reads.
 */
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type {
  BenchmarkMarks,
  CostInputs,
  Decision,
  PoolSnapshot,
  Signals,
  VirtualPosition,
} from '../types.js';

/** Prisma Decimal columns accept strings; this keeps float noise out of the ledger. */
function dec(value: number | undefined | null): string | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  return value.toFixed(18);
}

function decRequired(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`refusing to persist non-finite value: ${value}`);
  return value.toFixed(18);
}

export async function saveSnapshot(
  prisma: PrismaClient,
  managedPoolId: string,
  snapshot: PoolSnapshot,
  signals: Signals,
  costInputs: CostInputs,
): Promise<bigint> {
  const row = await prisma.snapshot.create({
    data: {
      managedPoolId,
      ts: new Date(snapshot.ts),
      activeBinId: snapshot.activeBinId,
      activePrice: decRequired(snapshot.activePrice),
      jupPrice: dec(snapshot.jupPrice),
      binStepBps: snapshot.binStepBps,
      feeBps: snapshot.feeBps.toFixed(6),
      liqActiveBin: decRequired(snapshot.liqActiveBin),
      liqNearbyJson: snapshot.liqNearby as unknown as InputJsonValue,
      poolTvlUsd: dec(snapshot.poolTvlUsd),
      poolVol24hUsd: dec(snapshot.poolVol24hUsd),
      poolFees24hUsd: dec(snapshot.poolFees24hUsd),
      poolFeesIntervalUsd: dec(snapshot.poolFeesIntervalUsd),
      volFast: signals.volFastAnnual.toFixed(8),
      volSlow: signals.volSlowAnnual.toFixed(8),
      costInputsJson: costInputs as unknown as InputJsonValue,
    },
    select: { id: true },
  });
  return row.id;
}

export async function saveDecision(
  prisma: PrismaClient,
  scope: { managedPoolId: string; strategyVersionId: string },
  snapshotId: bigint,
  decision: Decision,
  applied: boolean,
  ts: number,
): Promise<bigint> {
  const costEst = decision.kind === 'REBALANCE' || decision.kind === 'EXIT' ? decision.costEst : null;
  const row = await prisma.decision.create({
    data: {
      managedPoolId: scope.managedPoolId,
      strategyVersionId: scope.strategyVersionId,
      snapshotId,
      ts: new Date(ts),
      kind: decision.kind,
      reasonsJson: decision.reasons as unknown as InputJsonValue,
      costEstJson: (costEst as unknown as InputJsonValue | null) ?? undefined,
      newLowerBin: decision.kind === 'REBALANCE' ? decision.newLowerBin : null,
      newUpperBin: decision.kind === 'REBALANCE' ? decision.newUpperBin : null,
      applied,
    },
    select: { id: true },
  });
  return row.id;
}

export type VirtualEventKind = 'OPEN' | 'COMPOUND' | 'REBALANCE' | 'EXIT' | 'MARK';

export async function saveVirtualEvent(
  prisma: PrismaClient,
  managedPoolId: string,
  kind: VirtualEventKind,
  position: VirtualPosition,
  navUsd: number,
  ts: number,
  detail?: Record<string, unknown>,
): Promise<void> {
  await prisma.virtualPositionEvent.create({
    data: {
      managedPoolId,
      ts: new Date(ts),
      kind,
      lowerBinId: position.status === 'EXITED' ? null : position.lowerBinId,
      upperBinId: position.status === 'EXITED' ? null : position.upperBinId,
      baseAmount: decRequired(position.base),
      quoteAmount: decRequired(position.quote),
      feesAccruedQ: decRequired(position.cumFeesQuote),
      costsPaidQ: decRequired(position.cumCostsQuote),
      navUsd: decRequired(navUsd),
      // `bins` rides along so the loop can rebuild the exact per-bin inventory
      // after a restart — the aggregate columns alone would lose it.
      detailJson: { ...detail, position: serializePosition(position) } as unknown as InputJsonValue,
    },
  });
}

export async function saveBenchmarkMark(
  prisma: PrismaClient,
  managedPoolId: string,
  marks: BenchmarkMarks,
  ts: number,
): Promise<void> {
  await prisma.benchmarkMark.create({
    data: {
      managedPoolId,
      ts: new Date(ts),
      hodlNavUsd: decRequired(marks.hodlNavUsd),
      fullRangeUsd: decRequired(marks.fullRangeUsd),
      strategyUsd: decRequired(marks.strategyUsd),
    },
  });
}

export function serializePosition(position: VirtualPosition): Record<string, unknown> {
  return {
    status: position.status,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
    base: position.base,
    quote: position.quote,
    reserveQuote: position.reserveQuote,
    bins: position.bins,
    pendingFeesQuote: position.pendingFeesQuote,
    cumFeesQuote: position.cumFeesQuote,
    cumCostsQuote: position.cumCostsQuote,
    openedAt: position.openedAt,
    lastRebalanceAt: position.lastRebalanceAt,
    oorSince: position.oorSince,
    lastMarkPrice: position.lastMarkPrice,
    lastMarkBinId: position.lastMarkBinId,
  };
}

export function deserializePosition(raw: unknown): VirtualPosition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const nested = record.position;
  const source = (typeof nested === 'object' && nested !== null ? nested : record) as Record<
    string,
    unknown
  >;
  if (source.status !== 'ACTIVE' && source.status !== 'EXITED') return null;
  if (!Array.isArray(source.bins)) return null;
  return {
    ...source,
    reserveQuote: typeof source.reserveQuote === 'number' ? source.reserveQuote : 0,
  } as unknown as VirtualPosition;
}

// ---- KeyValue cursors -------------------------------------------------------

/**
 * Cursor scope: a ManagedPool id for per-pool state, a Tenant id for per-tenant
 * state, or "global". Passing the wrong one is the kind of bug that silently
 * mixes two pools' fee cursors, so the scope is always explicit.
 */
export async function readCursor<T>(
  prisma: PrismaClient,
  scope: string,
  key: string,
): Promise<T | null> {
  const row = await prisma.keyValue.findUnique({ where: { scope_key: { scope, key } } });
  return row ? (row.value as T) : null;
}

export async function writeCursor(
  prisma: PrismaClient,
  scope: string,
  key: string,
  value: unknown,
): Promise<void> {
  await prisma.keyValue.upsert({
    where: { scope_key: { scope, key } },
    create: { scope, key, value: value as InputJsonValue },
    update: { value: value as InputJsonValue },
  });
}

/** Scoped to a ManagedPool. */
export const CURSOR_CUMULATIVE_FEES = 'pool:cumulativeTradeFeeUsd';
/** Scoped to a ManagedPool. */
export const CURSOR_BENCHMARK_STATE = 'benchmark:state';
/** Scoped to a Tenant — one report per chat per day, covering all their pools. */
export const CURSOR_LAST_DAILY_REPORT = 'report:lastDailyReportDay';
