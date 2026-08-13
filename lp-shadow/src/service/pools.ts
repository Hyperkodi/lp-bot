/**
 * Pool registration and lookup for the bot layer: preview, add, list, resolve,
 * and mode transitions. Every function that touches a pool is scoped to a
 * tenant — a tenant can never see or move another tenant's pool.
 */
import { PublicKey } from '@solana/web3.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { addManagedPool, setPoolMode, type PoolMode } from '../ledger/registry.js';
import { errorMessage } from '../logger.js';
import { fetchPoolStats } from '../poller/meteoraApi.js';
import { ServiceError } from './errors.js';
import type { PoolPreview, PoolSummary } from './types.js';

const MS_PER_DAY = 86_400_000;

/** The managed-pool row shape the service works with (strategy included). */
export type PoolRow = {
  id: string;
  tenantId: string;
  poolAddress: string;
  label: string;
  virtualNavUsd: { toString(): string };
  role: string;
  mode: string;
  createdAt: Date;
  strategyVersion: { id: string; version: number; note: string; createdAt: Date; paramsJson: unknown };
};

export function toPoolSummary(row: PoolRow, daysOfData: number): PoolSummary {
  return {
    managedPoolId: row.id,
    label: row.label,
    poolAddress: row.poolAddress,
    mode: row.mode as PoolSummary['mode'],
    role: row.role as PoolSummary['role'],
    virtualNavUsd: Number(row.virtualNavUsd.toString()),
    strategyVersion: row.strategyVersion.version,
    createdAt: row.createdAt.toISOString(),
    daysOfData,
  };
}

export async function daysOfData(prisma: PrismaClient, managedPoolId: string): Promise<number> {
  const first = await prisma.snapshot.findFirst({
    where: { managedPoolId },
    orderBy: { ts: 'asc' },
    select: { ts: true },
  });
  return first ? (Date.now() - first.ts.getTime()) / MS_PER_DAY : 0;
}

export async function summarize(prisma: PrismaClient, row: PoolRow): Promise<PoolSummary> {
  return toPoolSummary(row, await daysOfData(prisma, row.id));
}

/**
 * Validates an address and pulls the public stats shown before /add confirms.
 * A pool the data API cannot describe (no bin step) is treated as unreachable
 * rather than half-registered.
 */
export async function previewPool(poolAddress: string): Promise<PoolPreview> {
  try {
    new PublicKey(poolAddress);
  } catch {
    throw new ServiceError('INVALID_INPUT', 'That is not a valid Solana address.');
  }

  let stats;
  try {
    stats = await fetchPoolStats(poolAddress);
  } catch (err) {
    throw new ServiceError(
      'POOL_UNREACHABLE',
      `Meteora's data API could not describe that pool (${errorMessage(err)}).`,
    );
  }
  if (stats.binStepBps === undefined) {
    throw new ServiceError(
      'POOL_UNREACHABLE',
      'That address does not look like a Meteora DLMM pool — no bin step reported.',
    );
  }

  return {
    poolAddress,
    name: stats.name ?? null,
    tvlUsd: stats.tvlUsd ?? null,
    vol24hUsd: stats.vol24hUsd ?? null,
    fees24hUsd: stats.fees24hUsd ?? null,
    binStepBps: stats.binStepBps ?? null,
    currentPrice: stats.apiPrice ?? null,
  };
}

export async function addPool(
  prisma: PrismaClient,
  strategy: { id: string },
  tenantId: string,
  input: { poolAddress: string; label: string; virtualNavUsd: number },
): Promise<PoolSummary> {
  if (!Number.isFinite(input.virtualNavUsd) || input.virtualNavUsd <= 0) {
    throw new ServiceError('INVALID_INPUT', 'The size must be a positive USD amount.');
  }
  const label = input.label.trim();
  if (label.length === 0) {
    throw new ServiceError('INVALID_INPUT', 'The pool needs a label.');
  }

  // Re-validate even though the bot previewed: the service must hold its own
  // invariants, whatever the caller did first.
  await previewPool(input.poolAddress);

  let created: { id: string };
  try {
    created = await addManagedPool(prisma, {
      tenantId,
      strategyVersionId: strategy.id,
      poolAddress: input.poolAddress,
      label,
      virtualNavUsd: input.virtualNavUsd,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new ServiceError('DUPLICATE_POOL', 'Already shadowing that pool.');
    }
    throw err;
  }

  const row = await prisma.managedPool.findUniqueOrThrow({
    where: { id: created.id },
    include: { strategyVersion: true },
  });
  return toPoolSummary(row, 0);
}

export async function listPoolRows(prisma: PrismaClient, tenantId: string): Promise<PoolRow[]> {
  return prisma.managedPool.findMany({
    where: { tenantId },
    include: { strategyVersion: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Turns whatever the user typed into exactly one of the tenant's pools.
 *
 * `ref` matches by managedPoolId, then pool address, then case-insensitive
 * label. Omitted `ref` works only when the tenant has exactly one non-stopped
 * pool — anything else is asked to be specific rather than guessed at.
 */
export async function resolvePoolRow(
  prisma: PrismaClient,
  tenantId: string,
  ref?: string,
): Promise<PoolRow> {
  const rows = await listPoolRows(prisma, tenantId);
  const trimmed = ref?.trim();

  if (!trimmed) {
    const active = rows.filter((row) => row.mode !== 'STOPPED');
    if (active.length === 1) return active[0]!;
    if (active.length === 0) {
      throw new ServiceError('NO_POOLS', 'No pools yet — add one with /add.');
    }
    throw new ServiceError(
      'POOL_AMBIGUOUS',
      `You have several pools — say which: ${active.map((row) => row.label).join(', ')}.`,
    );
  }

  const byId = rows.find((row) => row.id === trimmed);
  if (byId) return byId;
  const byAddress = rows.find((row) => row.poolAddress === trimmed);
  if (byAddress) return byAddress;

  const needle = trimmed.toLowerCase();
  const byLabel = rows.filter((row) => row.label.toLowerCase() === needle);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) {
    throw new ServiceError(
      'POOL_AMBIGUOUS',
      `"${trimmed}" matches more than one pool — use the address or id instead.`,
    );
  }

  throw new ServiceError(
    'POOL_NOT_FOUND',
    `No pool of yours matches "${trimmed}" — /pools lists them.`,
  );
}

const TRANSITIONS: Record<'pause' | 'resume' | 'remove', { from: string[]; to: PoolMode }> = {
  pause: { from: ['SHADOW'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'SHADOW' },
  remove: { from: ['SHADOW', 'PAUSED'], to: 'STOPPED' },
};

export async function transitionMode(
  prisma: PrismaClient,
  row: PoolRow,
  action: 'pause' | 'resume' | 'remove',
): Promise<PoolSummary> {
  const transition = TRANSITIONS[action];
  if (!transition.from.includes(row.mode)) {
    throw new ServiceError(
      'INVALID_INPUT',
      `${row.label} is ${row.mode} — ${action} needs it to be ${transition.from.join(' or ')}.`,
    );
  }
  await setPoolMode(prisma, row.id, transition.to);
  return summarize(prisma, { ...row, mode: transition.to });
}
