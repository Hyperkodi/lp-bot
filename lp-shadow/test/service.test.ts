/**
 * Service-layer tests: the contract the bot builds against.
 *
 * The Meteora data API is mocked; Postgres is real. DB-backed suites skip
 * themselves when DATABASE_URL is not set, same as loop.test.ts. Run with
 *   DATABASE_URL=... RPC_URL=... pnpm test
 * against a scratch database — it truncates every table it touches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hasDatabase = Boolean(process.env.DATABASE_URL);

vi.mock('../src/poller/meteoraApi.js', () => ({
  meteoraApiBase: vi.fn(() => 'mock://meteora'),
  intervalFeesUsd: vi.fn(() => ({ feesUsd: undefined, source: 'none' })),
  fetchPoolStats: vi.fn(async () => ({
    name: 'SOL-USDC',
    tvlUsd: 1_000_000,
    vol24hUsd: 250_000,
    fees24hUsd: 500,
    apiPrice: 150,
    cumulativeTradeFeeUsd: 10_000,
    binStepBps: 10,
  })),
}));

import { loadRawConfig, toParams } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import { publishStrategyVersion, upsertTenant } from '../src/ledger/registry.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import { ServiceError } from '../src/service/errors.js';
import { issueHandoff, newHandoffToken, redeemHandoff, getTenantByChatId } from '../src/service/handoff.js';
import { addPool, resolvePoolRow, transitionMode } from '../src/service/pools.js';
import { runReplayForPool } from '../src/service/replay.js';
import { getVerdict, getWhy } from '../src/service/reports.js';

// Any well-formed base58 32-byte strings work — the chain is never contacted.
const POOL_A = '11111111111111111111111111111111';
const POOL_B = 'So11111111111111111111111111111111111111112';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ServiceError ${code}, but the call succeeded`);
}

describe('handoff token shape', () => {
  it('stays inside the telegram start-payload alphabet and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = newHandoffToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });
});

describe.skipIf(!hasDatabase)('service layer', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');
  const configParams = toParams(loadRawConfig(), BINS_PER_CLASSIC_POSITION);

  let tenantId: string;
  let strategy: { id: string; version: number };

  beforeAll(async () => {
    await prisma.replayEvent.deleteMany({});
    await prisma.replayRun.deleteMany({});
    await prisma.decision.deleteMany({});
    await prisma.snapshot.deleteMany({});
    await prisma.virtualPositionEvent.deleteMany({});
    await prisma.benchmarkMark.deleteMany({});
    await prisma.keyValue.deleteMany({});
    await prisma.managedPool.deleteMany({});
    await prisma.strategyVersion.deleteMany({});
    await prisma.tenant.deleteMany({});

    strategy = await publishStrategyVersion(prisma, configParams, 'service test seed');
    const tenant = await upsertTenant(prisma, {
      externalUserId: 'svc-test-user',
      telegramChatId: 'svc-test-chat',
      label: 'Service Test',
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('issues and redeems a handoff exactly once', async () => {
    const { token } = await issueHandoff(prisma, {
      externalUserId: 'handoff-user',
      label: 'Handoff Project',
    });
    const tenant = await redeemHandoff(prisma, token, 'handoff-chat');
    expect(tenant.label).toBe('Handoff Project');
    expect(await getTenantByChatId(prisma, 'handoff-chat')).toMatchObject({
      externalUserId: 'handoff-user',
    });
    await expectCode(redeemHandoff(prisma, token, 'handoff-chat'), 'HANDOFF_INVALID');
  });

  it('rejects expired and malformed tokens', async () => {
    const { token } = await issueHandoff(prisma, {
      externalUserId: 'late-user',
      label: 'Late',
      ttlMinutes: -1,
    });
    await expectCode(redeemHandoff(prisma, token, 'late-chat'), 'HANDOFF_EXPIRED');
    await expectCode(redeemHandoff(prisma, 'not a token!', 'chat'), 'HANDOFF_INVALID');
  });

  it('adds a pool once and refuses the duplicate', async () => {
    const pool = await addPool(prisma, strategy, tenantId, {
      poolAddress: POOL_A,
      label: 'SOL-USDC',
      virtualNavUsd: 10_000,
    });
    expect(pool.mode).toBe('SHADOW');
    expect(pool.strategyVersion).toBe(strategy.version);
    await expectCode(
      addPool(prisma, strategy, tenantId, {
        poolAddress: POOL_A,
        label: 'again',
        virtualNavUsd: 5_000,
      }),
      'DUPLICATE_POOL',
    );
    await expectCode(
      addPool(prisma, strategy, tenantId, {
        poolAddress: POOL_B,
        label: 'bad size',
        virtualNavUsd: 0,
      }),
      'INVALID_INPUT',
    );
  });

  it('resolves pools by label, address, and sole-pool default', async () => {
    const sole = await resolvePoolRow(prisma, tenantId);
    expect(sole.poolAddress).toBe(POOL_A);
    expect((await resolvePoolRow(prisma, tenantId, 'sol-usdc')).poolAddress).toBe(POOL_A);
    expect((await resolvePoolRow(prisma, tenantId, POOL_A)).poolAddress).toBe(POOL_A);
    await expectCode(resolvePoolRow(prisma, tenantId, 'nonexistent'), 'POOL_NOT_FOUND');

    await addPool(prisma, strategy, tenantId, {
      poolAddress: POOL_B,
      label: 'WSOL-USDC',
      virtualNavUsd: 20_000,
    });
    await expectCode(resolvePoolRow(prisma, tenantId), 'POOL_AMBIGUOUS');

    const other = await upsertTenant(prisma, {
      externalUserId: 'other-user',
      telegramChatId: 'other-chat',
      label: 'Other',
    });
    await expectCode(resolvePoolRow(prisma, other.id), 'NO_POOLS');
    await expectCode(resolvePoolRow(prisma, other.id, 'SOL-USDC'), 'POOL_NOT_FOUND');
  });

  it('walks the mode transitions and rejects illegal ones', async () => {
    const row = await resolvePoolRow(prisma, tenantId, 'WSOL-USDC');
    expect((await transitionMode(prisma, row, 'pause')).mode).toBe('PAUSED');
    await expectCode(
      transitionMode(prisma, { ...row, mode: 'PAUSED' }, 'pause'),
      'INVALID_INPUT',
    );
    expect(
      (await transitionMode(prisma, { ...row, mode: 'PAUSED' }, 'resume')).mode,
    ).toBe('SHADOW');
    expect(
      (await transitionMode(prisma, { ...row, mode: 'SHADOW' }, 'remove')).mode,
    ).toBe('STOPPED');
    await expectCode(
      transitionMode(prisma, { ...row, mode: 'STOPPED' }, 'resume'),
      'INVALID_INPUT',
    );
  });

  it('reports why with the full gate trail', async () => {
    const row = await resolvePoolRow(prisma, tenantId, 'SOL-USDC');
    const snapshot = await prisma.snapshot.create({
      data: {
        managedPoolId: row.id,
        activeBinId: 100,
        activePrice: '150.5',
        binStepBps: 10,
        feeBps: '20',
        liqActiveBin: '50000',
        liqNearbyJson: [],
      },
      select: { id: true },
    });
    await prisma.decision.create({
      data: {
        managedPoolId: row.id,
        snapshotId: snapshot.id,
        strategyVersionId: row.strategyVersion.id,
        kind: 'HOLD',
        reasonsJson: ['a. in range'],
      },
    });
    await prisma.decision.create({
      data: {
        managedPoolId: row.id,
        snapshotId: snapshot.id,
        strategyVersionId: row.strategyVersion.id,
        kind: 'REBALANCE',
        reasonsJson: ['b. oor dwell PASS: 47.0min out of range, needs 30.0min'],
        applied: true,
      },
    });

    const why = await getWhy(prisma, row);
    expect(why.lastNonHold?.kind).toBe('REBALANCE');
    expect(why.lastNonHold?.reasons[0]).toContain('oor dwell PASS');
    expect(why.latest?.kind).toBe('REBALANCE');
    expect(why.decisions24h.HOLD).toBe(1);
    expect(why.decisions24h.REBALANCE).toBe(1);
  });

  it('fails every go-live gate on a pool with no evidence', async () => {
    const row = await resolvePoolRow(prisma, tenantId, 'WSOL-USDC');
    const verdict = await getVerdict(prisma, configParams, row);
    expect(verdict.pass).toBe(false);
    expect(verdict.beatsHodl).toBe(false);
    expect(verdict.lines).toHaveLength(3);
  });

  it('replays nothing gracefully', async () => {
    const row = await resolvePoolRow(prisma, tenantId, 'WSOL-USDC');
    const report = await runReplayForPool(prisma, row);
    expect(report.snapshots).toBe(0);
    expect(report.results).toEqual([]);
  });
});
