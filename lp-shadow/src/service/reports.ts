/**
 * Read-side service calls: /status, /why, /strategy, /verdict.
 *
 * Composition only — every number here was computed elsewhere (the loop, the
 * report module) and is being fetched, not re-derived.
 */
import { paramsForPool } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { buildDailyReport, evaluateGoLive, type GoLiveVerdict } from '../report/daily.js';
import { escapeHtml } from '../report/telegram.js';
import type { Params } from '../types.js';
import { ServiceError } from './errors.js';
import { summarize, type PoolRow } from './pools.js';
import type { DecisionDetail, StatusReport, StrategyInfo, VerdictReport, WhyReport } from './types.js';

const MS_PER_DAY = 86_400_000;

/**
 * evaluateGoLive aggregates the pool's entire snapshot history (its regime
 * check is defined over the whole shadow window), which is fine on the loop's
 * weekly cadence but not on a user-repeatable chat command. Five minutes of
 * staleness is nothing against a 4–6 week gate.
 */
export type GoLiveCache = Map<string, { at: number; verdict: GoLiveVerdict }>;
const GO_LIVE_TTL_MS = 5 * 60_000;

async function cachedGoLive(
  prisma: PrismaClient,
  params: Params,
  managedPoolId: string,
  cache: GoLiveCache,
): Promise<GoLiveVerdict> {
  const hit = cache.get(managedPoolId);
  if (hit && Date.now() - hit.at < GO_LIVE_TTL_MS) return hit.verdict;
  const verdict = await evaluateGoLive(prisma, params, managedPoolId, Date.now());
  // Drop what has gone stale rather than keeping an entry per pool ever
  // queried for the life of the process.
  for (const [key, entry] of cache) {
    if (Date.now() - entry.at >= GO_LIVE_TTL_MS) cache.delete(key);
  }
  cache.set(managedPoolId, { at: Date.now(), verdict });
  return verdict;
}

/**
 * The pool's effective Params: canonical strategy (from the version stamped on
 * the pool) over the shipped config for any field older versions lack, with
 * the pool's own identity and sizing on top — the same overlay the loop and
 * `pnpm report` use.
 */
export function poolParams(configParams: Params, row: PoolRow): Params {
  const stored = row.strategyVersion.paramsJson as Partial<Params>;
  return paramsForPool(
    { ...configParams, ...stored },
    {
      poolAddress: row.poolAddress,
      label: row.label,
      virtualNavUsd: Number(row.virtualNavUsd.toString()),
    },
  );
}

export async function getStatus(
  prisma: PrismaClient,
  configParams: Params,
  row: PoolRow,
  cache: GoLiveCache,
): Promise<StatusReport> {
  const params = poolParams(configParams, row);
  // On-demand status always shows the gate (the weekly cadence only governs
  // the pushed report), but through the cache — so the gate block is composed
  // here, mirroring daily.ts's formatting, instead of paying the full-history
  // aggregation on every /status.
  const report = await buildDailyReport(prisma, params, row.id, Date.now(), {
    includeGoLive: false,
  });
  const verdict = await cachedGoLive(prisma, params, row.id, cache);
  const gateLines = [
    '<b>Go-live gate (advisory)</b>',
    ...verdict.lines.map((line) => escapeHtml(line)),
    verdict.pass ? '<b>VERDICT: GATE CLEAR</b>' : '<b>VERDICT: KEEP SHADOWING</b>',
  ];
  return {
    pool: await summarize(prisma, row),
    html: `${report.text}\n${gateLines.join('\n')}`,
    verdictPass: verdict.pass,
  };
}

function toDetail(row: {
  kind: string;
  ts: Date;
  reasonsJson: unknown;
  applied: boolean;
}): DecisionDetail {
  return {
    kind: row.kind,
    ts: row.ts.toISOString(),
    reasons: Array.isArray(row.reasonsJson) ? (row.reasonsJson as string[]) : [],
    applied: row.applied,
  };
}

export async function getWhy(prisma: PrismaClient, row: PoolRow): Promise<WhyReport> {
  const select = { kind: true, ts: true, reasonsJson: true, applied: true } as const;
  const [lastNonHold, latest, counts] = await Promise.all([
    prisma.decision.findFirst({
      where: { managedPoolId: row.id, kind: { not: 'HOLD' } },
      orderBy: { ts: 'desc' },
      select,
    }),
    prisma.decision.findFirst({ where: { managedPoolId: row.id }, orderBy: { ts: 'desc' }, select }),
    prisma.decision.groupBy({
      by: ['kind'],
      where: { managedPoolId: row.id, ts: { gte: new Date(Date.now() - MS_PER_DAY) } },
      _count: { _all: true },
    }),
  ]);

  const decisions24h: Record<string, number> = {};
  for (const bucket of counts) decisions24h[bucket.kind] = bucket._count._all;

  return {
    pool: await summarize(prisma, row),
    lastNonHold: lastNonHold ? toDetail(lastNonHold) : null,
    latest: latest ? toDetail(latest) : null,
    decisions24h,
  };
}

export async function getStrategy(prisma: PrismaClient): Promise<StrategyInfo> {
  const latest = await prisma.strategyVersion.findFirst({ orderBy: { version: 'desc' } });
  if (!latest) {
    // createService seeds a version before handing out the service object, so
    // reaching this means the database was wiped underneath a running process.
    throw new ServiceError('INVALID_INPUT', 'No strategy is published yet — start the loop once.');
  }
  return {
    version: latest.version,
    note: latest.note,
    createdAt: latest.createdAt.toISOString(),
    params: latest.paramsJson as Record<string, unknown>,
  };
}

export async function getVerdict(
  prisma: PrismaClient,
  configParams: Params,
  row: PoolRow,
  cache: GoLiveCache,
): Promise<VerdictReport> {
  const verdict = await cachedGoLive(prisma, poolParams(configParams, row), row.id, cache);
  return {
    pool: await summarize(prisma, row),
    shadowDays: verdict.shadowDays,
    hasRegimeChange: verdict.hasRegimeChange,
    regimeRatio: verdict.regimeRatio,
    beatsHodl: verdict.beatsHodl,
    pass: verdict.pass,
    lines: verdict.lines,
  };
}
