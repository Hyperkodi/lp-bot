/**
 * End-to-end test of one full tick: poll -> signals -> decide -> apply
 * virtually -> persist, with the network stubbed and a real Postgres behind it.
 *
 * Needs a database, so it skips itself when DATABASE_URL is not set. Run it with
 *   DATABASE_URL=... RPC_URL=... pnpm test
 * against a scratch database — it truncates every table it touches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolSnapshotSource } from '../src/index.js';

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
    fetchUsdPrices: vi.fn(
      async () =>
        new Map([
          [actual.SOL_MINT, 150],
          ['BASE', stub.basePrice],
          ['QUOTE', 1],
        ]),
    ),
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

const { loadRawConfig, toParams } = await import('../src/config.js');
const { bootstrap, tick } = await import('../src/index.js');
const { disconnectPrisma, getPrisma } = await import('../src/ledger/prisma.js');
const { BINS_PER_CLASSIC_POSITION } = await import('../src/poller/sdkConstants.js');
const { fetchPoolStats } = await import('../src/poller/meteoraApi.js');

const params = toParams(
  { ...loadRawConfig('config/default.toml'), pool: { address: 'POOL', label: 'TEST' } },
  BINS_PER_CLASSIC_POSITION,
);

const telegram = { enabled: false, sent: [] as string[], async send(text: string) {
  this.sent.push(text);
} };

/** A pool that walks one bin up every tick. No RPC involved. */
function makeReader(startBinId = 1000): PoolSnapshotSource & { binId: number } {
  return {
    binId: startBinId,
    baseMint: 'BASE',
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
        baseMint: 'BASE',
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

  beforeAll(async () => {
    await prisma.replayEvent.deleteMany({});
    await prisma.replayRun.deleteMany({});
    await prisma.decision.deleteMany({});
    await prisma.snapshot.deleteMany({});
    await prisma.virtualPositionEvent.deleteMany({});
    await prisma.benchmarkMark.deleteMany({});
    await prisma.keyValue.deleteMany({});
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('persists a snapshot per tick and opens the position once vol is measurable', async () => {
    const reader = makeReader();
    const state = await bootstrap(prisma, params, reader);
    const start = Date.now() - 200 * params.snapshotIntervalSec * 1000;

    // 40 ticks: the first ones only persist snapshots while vol warms up, then
    // the position opens and starts marking.
    for (let i = 0; i < 40; i++) {
      reader.binId = 1000 + (i % 7);
      stub.basePrice = 150 * Math.pow(1.002, reader.binId - 1000);
      await tick(
        prisma,
        params,
        reader,
        telegram,
        state,
        'https://rpc.invalid',
        start + i * params.snapshotIntervalSec * 1000,
      );
    }

    expect(await prisma.snapshot.count()).toBe(40);
    expect(state.position).not.toBeNull();
    expect(state.position?.status).toBe('ACTIVE');

    const opens = await prisma.virtualPositionEvent.count({ where: { kind: 'OPEN' } });
    expect(opens).toBe(1);
    expect(await prisma.virtualPositionEvent.count({ where: { kind: 'MARK' } })).toBeGreaterThan(0);
    expect(await prisma.decision.count()).toBeGreaterThan(0);
    expect(await prisma.benchmarkMark.count()).toBeGreaterThan(0);
    // Pool and Jupiter agreed all the way through, so nothing was alerted.
    expect(telegram.sent).toEqual([]);
  });

  it('alerts when the pool price and Jupiter disagree by more than the threshold', async () => {
    const reader = makeReader();
    const state = await bootstrap(prisma, params, reader);
    telegram.sent.length = 0;

    reader.binId = 1000;
    stub.basePrice = 150 * 1.05; // 5% apart
    await tick(prisma, params, reader, telegram, state, 'https://rpc.invalid', Date.now());

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]).toContain('price divergence');
    expect(telegram.sent[0]).toContain('5.00%');
    telegram.sent.length = 0;
    stub.basePrice = 150;
  });

  it('stores the cost inputs and the reason trail alongside each decision', async () => {
    const decision = await prisma.decision.findFirst({ orderBy: { ts: 'desc' } });
    expect(decision).not.toBeNull();
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

  it('restores the virtual position and vol memory across a restart', async () => {
    const before = await prisma.virtualPositionEvent.findFirst({ orderBy: { ts: 'desc' } });
    const reborn = await bootstrap(prisma, params, makeReader());

    expect(reborn.position).not.toBeNull();
    expect(reborn.position!.bins.length).toBeGreaterThan(0);
    expect(reborn.position!.cumFeesQuote).toBeCloseTo(
      Number(before!.feesAccruedQ.toString()),
      6,
    );
    expect(reborn.regime.vol.slow.samples).toBeGreaterThan(0);
    expect(reborn.lastCumulativeFeeUsd).toBe(poolStats.cumulativeTradeFeeUsd);
  });

  it('skips the tick rather than fabricating a snapshot when the pool read fails', async () => {
    const before = await prisma.snapshot.count();
    const state = await bootstrap(prisma, params, makeReader());
    const broken: PoolSnapshotSource = {
      baseMint: 'BASE',
      quoteMint: 'QUOTE',
      snapshot: async () => {
        throw new Error('RPC exploded');
      },
    };

    await expect(
      tick(prisma, params, broken, telegram, state, 'https://rpc.invalid', Date.now()),
    ).rejects.toThrow('RPC exploded');
    expect(await prisma.snapshot.count()).toBe(before);
  });

  it('survives the pool stats API being down', async () => {
    vi.mocked(fetchPoolStats).mockRejectedValueOnce(new Error('502 from datapi'));
    const reader = makeReader();
    const state = await bootstrap(prisma, params, reader);
    const before = await prisma.snapshot.count();

    await tick(prisma, params, reader, telegram, state, 'https://rpc.invalid', Date.now());

    expect(await prisma.snapshot.count()).toBe(before + 1);
    const latest = await prisma.snapshot.findFirst({ orderBy: { ts: 'desc' } });
    expect(latest!.poolTvlUsd).toBeNull();
    // With no volume/TVL reading, the exit clock must stay unarmed.
    const decision = await prisma.decision.findFirst({ orderBy: { ts: 'desc' } });
    expect(decision!.kind).not.toBe('EXIT');
  });
});
