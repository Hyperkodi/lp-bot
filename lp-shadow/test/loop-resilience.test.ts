/**
 * What the loop does when the network lies rather than fails.
 *
 * The existing loop tests cover a poll that *throws*. These cover a poll that
 * *succeeds with nonsense* — the harder case, because nothing raises and the
 * bad value flows straight into the vol EWMAs, the decision engine, and the
 * ledger. This process is meant to run unattended for six weeks; a single
 * poisoned tick that persists silently is worse than a crash.
 *
 * Needs a database, so it skips itself when DATABASE_URL is not set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../src/index.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const poolStats = {
  tvlUsd: 10_000_000,
  vol24hUsd: 40_000_000,
  fees24hUsd: 20_000,
  apiPrice: 150,
  cumulativeTradeFeeUsd: 1_000_000,
  binStepBps: 20,
};

vi.mock('../src/poller/meteoraApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/poller/meteoraApi.js')>();
  return { ...actual, fetchPoolStats: vi.fn(async () => poolStats) };
});

vi.mock('../src/poller/jupiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/poller/jupiter.js')>();
  return {
    ...actual,
    fetchUsdPrices: vi.fn(async () => new Map<string, number>()),
    fetchQuote: vi.fn(async () => ({
      inAmount: 5_000_000_000,
      outAmount: 33_300_000_000,
      priceImpactPct: 0.0006,
      routeLabels: ['Meteora DLMM'],
    })),
  };
});

vi.mock('../src/poller/priorityFees.js', () => ({
  fetchPriorityFee: vi.fn(async () => ({
    microLamportsPerCu: 20_000,
    source: 'helius' as const,
  })),
}));

const { loadRawConfig, paramsForPool, toParams } = await import('../src/config.js');
const { bootstrap, tick } = await import('../src/index.js');
const { disconnectPrisma, getPrisma } = await import('../src/ledger/prisma.js');
const { addManagedPool, listActivePools, publishStrategyVersion, upsertTenant } = await import(
  '../src/ledger/registry.js'
);
const { BINS_PER_CLASSIC_POSITION } = await import('../src/poller/sdkConstants.js');
const { SOL_MINT } = await import('../src/poller/jupiter.js');

const configParams = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);

const telegram = {
  enabled: false,
  sent: [] as { chatId: string; text: string }[],
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  },
};

const prices = () =>
  new Map<string, number>([
    [SOL_MINT, 150],
    ['BASE', 150],
    ['QUOTE', 1],
  ]);

/**
 * A reader whose returned values the test controls field by field, so a single
 * poisoned field can be injected into an otherwise healthy snapshot.
 */
function makeReader() {
  return {
    binId: 1000,
    priceOverride: undefined as number | undefined,
    liqOverride: undefined as number | undefined,
    baseMint: 'BASE',
    quoteMint: 'QUOTE',
    async snapshot(ts: number) {
      const binId = this.binId;
      return {
        ts,
        activeBinId: binId,
        activePrice: this.priceOverride ?? 150 * Math.pow(1.002, binId - 1000),
        binStepBps: 20,
        feeBps: 20,
        liqActiveBin: this.liqOverride ?? 250_000,
        liqNearby: [{ binId, liquidity: 250_000 }],
        baseMint: 'BASE',
        quoteMint: 'QUOTE',
        baseDecimals: 9,
        quoteDecimals: 6,
        existingBinArrayIndexes: new Set([14, 15]),
      };
    },
  };
}

const { assertUsableSnapshot, BadSnapshotError } = await import('../src/poller/validate.js');

/** Pure, so these run with or without a database. */
describe('assertUsableSnapshot', () => {
  const good = {
    ts: 1,
    activeBinId: 1000,
    activePrice: 150,
    binStepBps: 20,
    feeBps: 20,
    liqActiveBin: 250_000,
    liqNearby: [{ binId: 1000, liquidity: 250_000 }],
    poolTvlUsd: 10_000_000,
    poolVol24hUsd: 40_000_000,
    poolFees24hUsd: 20_000,
    poolFeesIntervalUsd: 10,
    jupPrice: 150,
  };

  it('accepts a healthy snapshot', () => {
    expect(() => assertUsableSnapshot(good)).not.toThrow();
  });

  it('accepts a snapshot whose optional pool stats are absent', () => {
    // The stats API being down is normal and must not be treated as a lie.
    expect(() =>
      assertUsableSnapshot({
        ...good,
        poolTvlUsd: undefined,
        poolVol24hUsd: undefined,
        poolFees24hUsd: undefined,
        poolFeesIntervalUsd: undefined,
        jupPrice: undefined,
      }),
    ).not.toThrow();
  });

  it.each([
    ['activePrice NaN', { activePrice: Number.NaN }],
    ['activePrice Infinity', { activePrice: Number.POSITIVE_INFINITY }],
    ['activePrice zero', { activePrice: 0 }],
    ['activePrice negative', { activePrice: -1 }],
    ['binStepBps zero', { binStepBps: 0 }],
    ['feeBps negative', { feeBps: -1 }],
    ['feeBps NaN', { feeBps: Number.NaN }],
    ['liqActiveBin negative', { liqActiveBin: -5 }],
    ['liqActiveBin NaN', { liqActiveBin: Number.NaN }],
    ['activeBinId fractional', { activeBinId: 1000.5 }],
    ['activeBinId NaN', { activeBinId: Number.NaN }],
    ['nearby liquidity NaN', { liqNearby: [{ binId: 1, liquidity: Number.NaN }] }],
    ['poolTvlUsd NaN', { poolTvlUsd: Number.NaN }],
    ['poolVol24hUsd negative', { poolVol24hUsd: -1 }],
    ['jupPrice zero', { jupPrice: 0 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => assertUsableSnapshot({ ...good, ...patch })).toThrow(BadSnapshotError);
  });

  it('names the offending field so the alert is actionable', () => {
    expect(() => assertUsableSnapshot({ ...good, activePrice: Number.NaN })).toThrow(
      /activePrice/,
    );
  });
});

describe.skipIf(!hasDatabase)('loop resilience against bad poll data', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');

  let runner: Runner;
  let reader: ReturnType<typeof makeReader>;

  beforeAll(async () => {
    await prisma.replayEvent.deleteMany({});
    await prisma.replayRun.deleteMany({});
    await prisma.decision.deleteMany({});
    await prisma.snapshot.deleteMany({});
    await prisma.virtualPositionEvent.deleteMany({});
    await prisma.benchmarkMark.deleteMany({});
    await prisma.keyValue.deleteMany({});
    await prisma.managedPool.deleteMany({});
    await prisma.strategyProfileVersion.deleteMany({});
    await prisma.strategyProfile.deleteMany({});
    await prisma.strategyVersion.deleteMany({});
    await prisma.tenant.deleteMany({});

    const tenant = await upsertTenant(prisma, {
      externalUserId: 'resilience-user',
      telegramChatId: 'resilience-chat',
      label: 'Resilience',
    });
    const strategy = await publishStrategyVersion(prisma, configParams, 'resilience seed');
    const pool = await addManagedPool(prisma, {
      tenantId: tenant.id,
      strategyVersionId: strategy.id,
      poolAddress: 'POOL_RESILIENCE',
      label: 'R',
      virtualNavUsd: 10_000,
    });

    const active = await listActivePools(prisma);
    const target = active.find((p) => p.managedPoolId === pool.id)!;
    reader = makeReader();
    const params = paramsForPool({ ...configParams, ...target.strategyParams }, target);
    runner = {
      pool: target,
      params,
      reader,
      state: await bootstrap(prisma, params, reader, target.managedPoolId),
    };
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  /** Warm the vol EWMAs so the position can open, then return the tick count. */
  async function warmUp(ticks = 40): Promise<void> {
    const start = Date.now() - ticks * 60_000;
    for (let i = 0; i < ticks; i += 1) {
      reader.binId = 1000 + (i % 3);
      await tick(prisma, runner, telegram, 'http://rpc.invalid/', start + i * 60_000, prices());
    }
  }

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -150],
  ])('refuses to persist a snapshot whose price is %s', async (_label, badPrice) => {
    await warmUp();
    const before = await prisma.snapshot.count({ where: { managedPoolId: runner.pool.managedPoolId } });

    reader.priceOverride = badPrice;
    await tick(
      prisma,
      runner,
      telegram,
      'http://rpc.invalid/',
      Date.now(),
      prices(),
    ).catch(() => undefined);
    reader.priceOverride = undefined;

    const after = await prisma.snapshot.count({ where: { managedPoolId: runner.pool.managedPoolId } });
    expect(after).toBe(before);
  });

  it('never lets a bad tick poison the stored ledger with a non-finite number', async () => {
    await warmUp();
    reader.priceOverride = Number.NaN;
    await tick(prisma, runner, telegram, 'http://rpc.invalid/', Date.now(), prices()).catch(
      () => undefined,
    );
    reader.priceOverride = undefined;

    // Whatever the loop decided to do with the bad tick, nothing non-finite
    // may reach the ledger: a NaN here is permanent (Postgres numeric accepts
    // it) and silently corrupts every downstream average and benchmark.
    const rows = await prisma.snapshot.findMany({
      where: { managedPoolId: runner.pool.managedPoolId },
      select: { activePrice: true, liqActiveBin: true, volFast: true, volSlow: true },
    });
    for (const row of rows) {
      expect(Number.isFinite(Number(row.activePrice.toString()))).toBe(true);
      expect(Number.isFinite(Number(row.liqActiveBin.toString()))).toBe(true);
      if (row.volFast !== null) {
        expect(Number.isFinite(Number(row.volFast.toString()))).toBe(true);
      }
      if (row.volSlow !== null) {
        expect(Number.isFinite(Number(row.volSlow.toString()))).toBe(true);
      }
    }

    const marks = await prisma.benchmarkMark.findMany({
      where: { managedPoolId: runner.pool.managedPoolId },
      select: { strategyUsd: true, hodlNavUsd: true, fullRangeUsd: true },
    });
    for (const mark of marks) {
      expect(Number.isFinite(Number(mark.strategyUsd.toString()))).toBe(true);
      expect(Number.isFinite(Number(mark.hodlNavUsd.toString()))).toBe(true);
      expect(Number.isFinite(Number(mark.fullRangeUsd.toString()))).toBe(true);
    }
  });

  it('recovers on the next good tick rather than staying poisoned', async () => {
    await warmUp();
    reader.priceOverride = Number.NaN;
    await tick(prisma, runner, telegram, 'http://rpc.invalid/', Date.now(), prices()).catch(
      () => undefined,
    );
    reader.priceOverride = undefined;

    const before = await prisma.snapshot.count({ where: { managedPoolId: runner.pool.managedPoolId } });
    await tick(prisma, runner, telegram, 'http://rpc.invalid/', Date.now() + 60_000, prices());
    const after = await prisma.snapshot.count({ where: { managedPoolId: runner.pool.managedPoolId } });

    // A rejected tick must not wedge the loop: the very next healthy poll is
    // recorded normally, with finite vol.
    expect(after).toBe(before + 1);
    const latest = await prisma.snapshot.findFirst({
      where: { managedPoolId: runner.pool.managedPoolId },
      orderBy: { ts: 'desc' },
      select: { activePrice: true, volSlow: true },
    });
    expect(Number.isFinite(Number(latest!.activePrice.toString()))).toBe(true);
    expect(Number(latest!.activePrice.toString())).toBeGreaterThan(0);
  });
});
