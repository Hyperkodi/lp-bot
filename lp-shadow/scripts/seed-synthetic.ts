/**
 * Seeds the ledger with synthetic snapshots so the schema, the persistence
 * layer and the replay harness can be smoke-tested on a fresh Postgres without
 * waiting days for real data.
 *
 *   pnpm exec tsx scripts/seed-synthetic.ts --hours 48 --wipe
 *   pnpm replay --from 2026-01-01 --dry-run
 *
 * This writes to the `Snapshot` table only. It is a local development aid — do
 * not point it at the database that holds a real shadow run, and never treat
 * its output as evidence about the strategy.
 */
import 'dotenv/config';
import { loadEnv, loadRawConfig, toParams } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import { saveSnapshot } from '../src/ledger/persist.js';
import { log } from '../src/logger.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import { initRegimeState, updateRegime } from '../src/signals/regime.js';
import type { CostInputs, PoolSnapshot } from '../src/types.js';

/** Deterministic PRNG so two seed runs produce the same series. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function arg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const params = toParams(loadRawConfig(), BINS_PER_CLASSIC_POSITION);
  const prisma = getPrisma(env.DATABASE_URL);

  const hours = Number(arg('--hours', '48'));
  const intervalSec = params.snapshotIntervalSec;
  const ticks = Math.floor((hours * 3600) / intervalSec);
  const rand = mulberry32(Number(arg('--seed', '42')));

  if (process.argv.includes('--wipe')) {
    await prisma.replayEvent.deleteMany({});
    await prisma.replayRun.deleteMany({});
    await prisma.decision.deleteMany({});
    await prisma.snapshot.deleteMany({});
    await prisma.virtualPositionEvent.deleteMany({});
    await prisma.benchmarkMark.deleteMany({});
    await prisma.keyValue.deleteMany({});
    log.info('wiped existing ledger rows');
  }

  const binStepBps = 20;
  const startTs = Date.now() - ticks * intervalSec * 1000;
  let price = 150;
  let regime = initRegimeState();

  for (let i = 0; i < ticks; i++) {
    const ts = startTs + i * intervalSec * 1000;
    // Regime switch halfway through so the go-live gate has something to see.
    const sigmaPerTick = i < ticks / 2 ? 0.0006 : 0.0024;
    // Box-Muller from two uniforms.
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    const shock = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    price *= Math.exp(sigmaPerTick * shock);

    const activeBinId = 1000 + Math.round(Math.log(price / 150) / Math.log(1 + binStepBps / 10_000));
    const snapshot: PoolSnapshot = {
      ts,
      activeBinId,
      activePrice: price,
      binStepBps,
      feeBps: 20,
      liqActiveBin: 250_000,
      liqNearby: [],
      poolTvlUsd: 10_000_000,
      poolVol24hUsd: 40_000_000,
      poolFees24hUsd: 20_000,
      poolFeesIntervalUsd: 20_000 * (intervalSec / 86_400),
      jupPrice: price,
    };

    const updated = updateRegime(regime, snapshot, params);
    regime = updated.state;

    const costInputs: CostInputs = {
      swapNotionalUsd: params.virtualNavUsd * params.swapShareOfNav,
      swapOutValueUsd: params.virtualNavUsd * params.swapShareOfNav * 0.9994,
      quotePriceImpactPct: 0.0006,
      priorityFeeMicroLamportsPerCu: 20_000,
      solPriceUsd: price,
      newBinArrayRentLamports: 0,
    };

    await saveSnapshot(prisma, snapshot, updated.signals, costInputs);
  }

  log.info(`seeded ${ticks} synthetic snapshots spanning ${hours}h`);
  await disconnectPrisma();
}

main().catch(async (err) => {
  log.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`, err);
  await disconnectPrisma().catch(() => undefined);
  process.exitCode = 1;
});
