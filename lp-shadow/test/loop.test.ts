/**
 * End-to-end test of one full tick: poll -> signals -> decide -> apply
 * virtually -> persist, with the network stubbed and a real Postgres behind it.
 *
 * Needs a database, so it skips itself when DATABASE_URL is not set. Run it with
 *   DATABASE_URL=... RPC_URL=... pnpm test
 * against a scratch database — it truncates every table it touches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../src/index.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

/** Mutable stub state, so a test can drive the pool and Jupiter apart. */
const stub = { basePrice: 150 };

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
const { addManagedPool, listActivePools, publishStrategyVersion, setPoolMode, trackRecord, upsertTenant } =
  await import('../src/ledger/registry.js');
const { BINS_PER_CLASSIC_POSITION } = await import('../src/poller/sdkConstants.js');
const { SOL_MINT } = await import('../src/poller/jupiter.js');
const { fetchPoolStats } = await import('../src/poller/meteoraApi.js');

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
    ['BASE', stub.basePrice],
    ['QUOTE', 1],
  ]);

/** A pool whose active bin the test drives directly. No RPC involved. */
function makeReader(baseMint = 'BASE') {
  return {
    binId: 1000,
    baseMint,
    quoteMint: 'QUOTE',
    async snapshot(ts: number) {
      const binId = this.binId;
      return {
        ts,
        activeBinId: binId,
        activePrice: 150 * Math.pow(1.002, binId - 1000),
        binStepBps: 20,
        feeBps: 20,
        liqActiveBin: 250_000,
        liqNearby: [{ binId, liquidity: 250_000 }],
        baseMint,
        quoteMint: 'QUOTE',
        baseDecimals: 9,
        quoteDecimals: 6,
        existingBinArrayIndexes: new Set([14, 15]),
      };
    },
  };
}

describe.skipIf(!hasDatabase)('main loop tick', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');

  let runner: Runner;
  let reader: ReturnType<typeof makeReader>;
  let secondPoolId: string;

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
      externalUserId: 'parent-bot-user-1',
      telegramChatId: 'chat-1',
      label: 'Test Project',
    });
    const strategy = await publishStrategyVersion(prisma, configParams, 'test seed');
    const pool = await addManagedPool(prisma, {
      tenantId: tenant.id,
      strategyVersionId: strategy.id,
      poolAddress: 'POOL_A',
      label: 'A',
      virtualNavUsd: 10_000,
    });
    const second = await addManagedPool(prisma, {
      tenantId: tenant.id,
      strategyVersionId: strategy.id,
      poolAddress: 'POOL_B',
      label: 'B',
      virtualNavUsd: 25_000,
    });
    secondPoolId = second.id;

    const active = await listActivePools(prisma);
    const poolA = active.find((p) => p.managedPoolId === pool.id)!;
    reader = makeReader();
    const params = paramsForPool({ ...configParams, ...poolA.strategyParams }, poolA);
    runner = {
      pool: poolA,
      params,
      reader,
      state: await bootstrap(prisma, params, reader, poolA.managedPoolId),
    };
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('registers the tenant, strategy and pools', async () => {
    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.strategyVersion.count()).toBe(1);
    expect(await prisma.managedPool.count()).toBe(2);
    // Each pool carries its own sizing while sharing the canonical strategy.
    const active = await listActivePools(prisma);
    expect(active.map((p) => p.virtualNavUsd).sort((a, b) => a - b)).toEqual([10_000, 25_000]);
    expect(new Set(active.map((p) => p.strategyVersionId)).size).toBe(1);
  });

  it('does not republish a strategy version when the params are unchanged', async () => {
    const again = await publishStrategyVersion(prisma, configParams, 'same params');
    expect(again.version).toBe(1);
    expect(await prisma.strategyVersion.count()).toBe(1);
  });

  it('persists a snapshot per tick and opens the position once vol is measurable', async () => {
    const start = Date.now() - 200 * runner.params.snapshotIntervalSec * 1000;

    for (let i = 0; i < 40; i++) {
      reader.binId = 1000 + (i % 7);
      stub.basePrice = 150 * Math.pow(1.002, reader.binId - 1000);
      await tick(
        prisma,
        runner,
        telegram,
        'https://rpc.invalid',
        start + i * runner.params.snapshotIntervalSec * 1000,
        prices(),
      );
    }

    expect(await prisma.snapshot.count()).toBe(40);
    expect(runner.state.position).not.toBeNull();
    expect(runner.state.position?.status).toBe('ACTIVE');

    expect(await prisma.virtualPositionEvent.count({ where: { kind: 'OPEN' } })).toBe(1);
    expect(await prisma.virtualPositionEvent.count({ where: { kind: 'MARK' } })).toBeGreaterThan(0);
    expect(await prisma.decision.count()).toBeGreaterThan(0);
    expect(await prisma.benchmarkMark.count()).toBeGreaterThan(0);
    // Pool and Jupiter agreed all the way through, so nothing was alerted.
    expect(telegram.sent).toEqual([]);
  });

  it('writes every row against the pool it came from, and nothing against the other', async () => {
    // This is the whole point of the multi-tenant change: pool B is registered
    // and has been ticked zero times, so it must hold zero rows.
    for (const table of ['snapshot', 'decision', 'virtualPositionEvent', 'benchmarkMark'] as const) {
      const mine = await (prisma[table] as { count(args: unknown): Promise<number> }).count({
        where: { managedPoolId: runner.pool.managedPoolId },
      });
      const theirs = await (prisma[table] as { count(args: unknown): Promise<number> }).count({
        where: { managedPoolId: secondPoolId },
      });
      expect(mine).toBeGreaterThan(0);
      expect(theirs).toBe(0);
    }

    // Cursors are scoped too — pool B must not inherit pool A's fee cursor.
    const cursors = await prisma.keyValue.findMany();
    expect(cursors.every((row) => row.scope !== secondPoolId)).toBe(true);
    expect(cursors.some((row) => row.scope === runner.pool.managedPoolId)).toBe(true);
  });

  it('stamps the strategy version on every decision', async () => {
    const decisions = await prisma.decision.findMany({ select: { strategyVersionId: true } });
    const versions = new Set(decisions.map((d) => d.strategyVersionId));
    expect(versions.size).toBe(1);
    expect([...versions][0]).toBe(runner.pool.strategyVersionId);
  });

  it('stores the cost inputs and the reason trail alongside each decision', async () => {
    const decision = await prisma.decision.findFirst({ orderBy: { ts: 'desc' } });
    expect(Array.isArray(decision!.reasonsJson)).toBe(true);
    expect((decision!.reasonsJson as string[]).length).toBeGreaterThan(0);

    const snapshot = await prisma.snapshot.findFirst({ orderBy: { ts: 'desc' } });
    const costInputs = snapshot!.costInputsJson as Record<string, unknown>;
    expect(costInputs.priorityFeeMicroLamportsPerCu).toBe(20_000);
    expect(costInputs.solPriceUsd).toBe(150);
    // The quote came back, so the swap cost is measured rather than assumed.
    expect(costInputs.swapOutValueUsd).not.toBeNull();
  });

  it('derives interval fees from the cumulative-fee cursor once it is warm', async () => {
    const rows = await prisma.snapshot.findMany({
      orderBy: { ts: 'asc' },
      select: { poolFeesIntervalUsd: true },
    });
    // First tick has no cursor yet, so it pro-rates the 24h figure; later ticks
    // see a flat cumulative counter and therefore a zero delta.
    expect(Number(rows[0]!.poolFeesIntervalUsd!.toString())).toBeGreaterThan(0);
    expect(Number(rows.at(-1)!.poolFeesIntervalUsd!.toString())).toBe(0);
  });

  it('alerts the tenant chat when the pool price and Jupiter disagree', async () => {
    telegram.sent.length = 0;
    reader.binId = 1000;
    stub.basePrice = 150 * 1.05; // 5% apart

    await tick(prisma, runner, telegram, 'https://rpc.invalid', Date.now(), prices());

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]!.chatId).toBe('chat-1');
    expect(telegram.sent[0]!.text).toContain('price divergence');
    expect(telegram.sent[0]!.text).toContain('5.00%');
    telegram.sent.length = 0;
    stub.basePrice = 150;
  });

  it('restores the virtual position and vol memory across a restart', async () => {
    const before = await prisma.virtualPositionEvent.findFirst({ orderBy: { ts: 'desc' } });
    const reborn = await bootstrap(
      prisma,
      runner.params,
      makeReader(),
      runner.pool.managedPoolId,
    );

    expect(reborn.position).not.toBeNull();
    expect(reborn.position!.bins.length).toBeGreaterThan(0);
    expect(reborn.position!.cumFeesQuote).toBeCloseTo(Number(before!.feesAccruedQ.toString()), 6);
    expect(reborn.regime.vol.slow.samples).toBeGreaterThan(0);
    expect(reborn.lastCumulativeFeeUsd).toBe(poolStats.cumulativeTradeFeeUsd);
  });

  it('boots a second pool with no memory of the first', async () => {
    const active = await listActivePools(prisma);
    const poolB = active.find((p) => p.managedPoolId === secondPoolId)!;
    const state = await bootstrap(
      prisma,
      paramsForPool({ ...configParams, ...poolB.strategyParams }, poolB),
      makeReader(),
      secondPoolId,
    );
    expect(state.position).toBeNull();
    expect(state.benchmarks).toBeNull();
    expect(state.lastCumulativeFeeUsd).toBeNull();
    expect(state.regime.vol.slow.samples).toBe(0);
  });

  it('skips the tick rather than fabricating a snapshot when the pool read fails', async () => {
    const before = await prisma.snapshot.count();
    const broken: Runner = {
      ...runner,
      reader: {
        baseMint: 'BASE',
        quoteMint: 'QUOTE',
        snapshot: async () => {
          throw new Error('RPC exploded');
        },
      },
    };

    await expect(
      tick(prisma, broken, telegram, 'https://rpc.invalid', Date.now(), prices()),
    ).rejects.toThrow('RPC exploded');
    expect(await prisma.snapshot.count()).toBe(before);
  });

  it('survives the pool stats API being down', async () => {
    vi.mocked(fetchPoolStats).mockRejectedValueOnce(new Error('502 from datapi'));
    const before = await prisma.snapshot.count();

    await tick(prisma, runner, telegram, 'https://rpc.invalid', Date.now(), prices());

    expect(await prisma.snapshot.count()).toBe(before + 1);
    const latest = await prisma.snapshot.findFirst({ orderBy: { ts: 'desc' } });
    expect(latest!.poolTvlUsd).toBeNull();
    // With no volume/TVL reading, the exit clock must stay unarmed.
    const decision = await prisma.decision.findFirst({ orderBy: { ts: 'desc' } });
    expect(decision!.kind).not.toBe('EXIT');
  });

  it('drops a pool from the active set once it is paused or stopped', async () => {
    await setPoolMode(prisma, secondPoolId, 'PAUSED');
    expect((await listActivePools(prisma)).map((p) => p.managedPoolId)).not.toContain(secondPoolId);

    await setPoolMode(prisma, secondPoolId, 'SHADOW');
    expect((await listActivePools(prisma)).map((p) => p.managedPoolId)).toContain(secondPoolId);
  });

  it('keeps stopped pools in the track record rather than dropping them', async () => {
    await setPoolMode(prisma, runner.pool.managedPoolId, 'STOPPED');
    const rows = await trackRecord(prisma);

    // Pool A has marks and is STOPPED — it must still be counted. Excluding
    // losers is how a track record turns into marketing.
    const poolA = rows.find((r) => r.managedPoolId === runner.pool.managedPoolId);
    expect(poolA).toBeDefined();
    expect(poolA!.stopped).toBe(true);
    expect(poolA!.strategyVersion).toBe(1);
    expect(poolA!.days).toBeGreaterThan(0);

    // Stopping frees the live slot so the pool can be re-added as a new run…
    const stoppedRow = await prisma.managedPool.findUniqueOrThrow({
      where: { id: runner.pool.managedPoolId },
      select: { runSeq: true },
    });
    expect(stoppedRow.runSeq).toBeGreaterThan(0n);

    // …and reviving one reclaims it, so a live row never sits outside the
    // one-live-run-per-pool constraint.
    await setPoolMode(prisma, runner.pool.managedPoolId, 'SHADOW');
    const revivedRow = await prisma.managedPool.findUniqueOrThrow({
      where: { id: runner.pool.managedPoolId },
      select: { runSeq: true, stoppedAt: true },
    });
    expect(revivedRow.runSeq).toBe(0n);
    expect(revivedRow.stoppedAt).toBeNull();
  });
});
