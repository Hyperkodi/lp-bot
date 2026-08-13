/**
 * The registry: tenants, the canonical strategy, and the pools being shadowed.
 *
 * This is the seam the parent bot talks to. Identity arrives already
 * authenticated — `upsertTenant` records it, it never establishes it — and the
 * Telegram layer is just one caller of these functions.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import { log } from '../logger.js';
import type { Params } from '../types.js';

export type PoolMode = 'SHADOW' | 'PAUSED' | 'STOPPED';
export type PoolRole = 'PRIMARY' | 'REFERENCE';

export type ActivePool = {
  managedPoolId: string;
  tenantId: string;
  telegramChatId: string;
  strategyVersionId: string;
  strategyVersion: number;
  poolAddress: string;
  label: string;
  virtualNavUsd: number;
  role: PoolRole;
  strategyParams: Params;
};

/**
 * Registers (or refreshes) a tenant handed off from the parent bot.
 *
 * `externalUserId` is the parent's account id and is the real key; the chat id
 * is where messages go and can change if the user restarts the conversation.
 */
export async function upsertTenant(
  prisma: PrismaClient,
  input: { externalUserId: string; telegramChatId: string; label: string },
): Promise<{ id: string }> {
  return prisma.tenant.upsert({
    where: { externalUserId: input.externalUserId },
    create: input,
    update: { telegramChatId: input.telegramChatId, label: input.label },
    select: { id: true },
  });
}

/**
 * Publishes a new canonical strategy version, or returns the current one when
 * the parameters are unchanged.
 *
 * `note` is required by the schema on purpose: an unexplained parameter change
 * is how a track record quietly stops meaning anything.
 */
export async function publishStrategyVersion(
  prisma: PrismaClient,
  params: Params,
  note: string,
): Promise<{ id: string; version: number }> {
  const latest = await prisma.strategyVersion.findFirst({
    orderBy: { version: 'desc' },
    select: { id: true, version: true, paramsJson: true },
  });

  const next = strategyOnly(params);
  // Canonical ordering matters: Postgres jsonb does not preserve key order, so
  // a plain JSON.stringify comparison against a stored row never matches and
  // every restart would publish a fresh version — quietly destroying the
  // versioning scheme this function exists to maintain.
  if (latest && canonicalJson(latest.paramsJson) === canonicalJson(next)) {
    return { id: latest.id, version: latest.version };
  }

  const created = await prisma.strategyVersion.create({
    data: {
      version: (latest?.version ?? 0) + 1,
      paramsJson: next as unknown as InputJsonValue,
      note,
    },
    select: { id: true, version: true },
  });
  log.info(`published strategy version ${created.version}: ${note}`);
  return created;
}

/**
 * Strips the per-pool fields out of `Params`.
 *
 * Pool address, label and NAV belong to the ManagedPool, not the strategy —
 * leaving them in would make every pool look like its own strategy version and
 * destroy the aggregate claim.
 */
/** Stable serialization for comparing parameter sets across a jsonb round-trip. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function strategyOnly(params: Params): Omit<Params, 'poolAddress' | 'poolLabel' | 'virtualNavUsd'> {
  const { poolAddress: _a, poolLabel: _l, virtualNavUsd: _n, ...rest } = params;
  return rest;
}

export async function addManagedPool(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    strategyVersionId: string;
    poolAddress: string;
    label: string;
    virtualNavUsd: number;
    role?: PoolRole;
  },
): Promise<{ id: string }> {
  return prisma.managedPool.create({
    data: {
      tenantId: input.tenantId,
      strategyVersionId: input.strategyVersionId,
      poolAddress: input.poolAddress,
      label: input.label,
      virtualNavUsd: input.virtualNavUsd.toFixed(18),
      role: input.role ?? 'PRIMARY',
    },
    select: { id: true },
  });
}

export async function setPoolMode(
  prisma: PrismaClient,
  managedPoolId: string,
  mode: PoolMode,
): Promise<void> {
  const stoppedAt = mode === 'STOPPED' ? new Date() : null;
  await prisma.managedPool.update({
    where: { id: managedPoolId },
    data: {
      mode,
      stoppedAt,
      // Stopping stamps the run into the uniqueness key so the pool can be
      // re-added as a fresh run; live rows always carry 0. Reviving a stopped
      // row therefore has to reclaim slot 0 — and if another live run already
      // holds it, the unique constraint says so rather than letting two live
      // runs of one pool coexist.
      runSeq: stoppedAt ? BigInt(stoppedAt.getTime()) : BigInt(0),
    },
  });
}

/**
 * Every pool the loop should be ticking.
 *
 * Only SHADOW is accepted. When a signing phase adds LIVE it must be an
 * explicit, separate opt-in here — never a value this function silently starts
 * acting on.
 */
export async function listActivePools(prisma: PrismaClient): Promise<ActivePool[]> {
  const rows = await prisma.managedPool.findMany({
    where: { mode: 'SHADOW', tenant: { status: 'ACTIVE' } },
    include: { tenant: true, strategyVersion: true },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    managedPoolId: row.id,
    tenantId: row.tenantId,
    telegramChatId: row.tenant.telegramChatId,
    strategyVersionId: row.strategyVersionId,
    strategyVersion: row.strategyVersion.version,
    poolAddress: row.poolAddress,
    label: row.label,
    virtualNavUsd: Number(row.virtualNavUsd.toString()),
    role: row.role as PoolRole,
    strategyParams: row.strategyVersion.paramsJson as unknown as Params,
  }));
}

export type TrackRecordRow = {
  managedPoolId: string;
  label: string;
  strategyVersion: number;
  days: number;
  strategyUsd: number;
  hodlUsd: number;
  beatsHodl: boolean;
  stopped: boolean;
};

/**
 * The aggregate claim: how many pools the strategy actually beat HODL on.
 *
 * Counts STOPPED pools deliberately. Dropping pools that did badly turns "beat
 * HODL on 14 of 20" into marketing rather than evidence, and there is no way to
 * add that credibility back later — so the survivorship decision is made here,
 * once, rather than at each call site.
 */
export async function trackRecord(
  prisma: PrismaClient,
  opts: { strategyVersion?: number; role?: PoolRole } = {},
): Promise<TrackRecordRow[]> {
  const pools = await prisma.managedPool.findMany({
    where: {
      role: opts.role ?? 'PRIMARY',
      ...(opts.strategyVersion === undefined
        ? {}
        : { strategyVersion: { version: opts.strategyVersion } }),
    },
    include: { strategyVersion: { select: { version: true } } },
  });

  const rows: TrackRecordRow[] = [];
  for (const pool of pools) {
    const [first, latest] = await Promise.all([
      prisma.snapshot.findFirst({
        where: { managedPoolId: pool.id },
        orderBy: { ts: 'asc' },
        select: { ts: true },
      }),
      prisma.benchmarkMark.findFirst({
        where: { managedPoolId: pool.id },
        orderBy: { ts: 'desc' },
      }),
    ]);
    if (!first || !latest) continue;

    const strategyUsd = Number(latest.strategyUsd.toString());
    const hodlUsd = Number(latest.hodlNavUsd.toString());
    rows.push({
      managedPoolId: pool.id,
      label: pool.label,
      strategyVersion: pool.strategyVersion.version,
      days: (latest.ts.getTime() - first.ts.getTime()) / 86_400_000,
      strategyUsd,
      hodlUsd,
      beatsHodl: strategyUsd > hodlUsd,
      stopped: pool.mode === 'STOPPED',
    });
  }
  return rows;
}
