/**
 * lp-shadow Phase 1 main loop: poll -> signals -> decide -> apply virtually ->
 * persist.
 *
 * Shadow mode. This process holds no keys, builds no transactions, and has no
 * code path that could send one. The terminal output of every tick is a row in
 * the ledger.
 *
 * A note on units: NAV is denominated in the pool's quote token and reported as
 * USD. That holds because Phase 1 targets a USD-stablecoin-quoted pool; point
 * it at a non-USD-quoted pool and the dollar figures become quote units wearing
 * a dollar sign.
 */
import 'dotenv/config';
import { planRange } from './binMath.js';
import { isWeeklyReportDay, localDayKey, localHour, sleep } from './clock.js';
import { loadEnv, loadRawConfig, toParams } from './config.js';
import { decide, positionNavUsd } from './decision/engine.js';
import { estimateCost } from './decision/costs.js';
import type { PrismaClient } from './generated/prisma/client.js';
import {
  CURSOR_BENCHMARK_STATE,
  CURSOR_CUMULATIVE_FEES,
  CURSOR_LAST_DAILY_REPORT,
  deserializePosition,
  readCursor,
  saveBenchmarkMark,
  saveDecision,
  saveSnapshot,
  saveVirtualEvent,
  writeCursor,
} from './ledger/persist.js';
import { disconnectPrisma, getPrisma } from './ledger/prisma.js';
import { errorMessage, log } from './logger.js';
import { fetchQuote, fetchUsdPrices, SOL_MINT } from './poller/jupiter.js';
import { PoolReader, type OnChainSnapshot } from './poller/meteora.js';
import { fetchPoolStats, intervalFeesUsd, type PoolStats } from './poller/meteoraApi.js';
import { fetchPriorityFee } from './poller/priorityFees.js';
import {
  BINS_PER_CLASSIC_POSITION,
  newBinArrayRentLamports,
  POSITION_RENT_LAMPORTS,
} from './poller/sdkConstants.js';
import { buildDailyReport } from './report/daily.js';
import { createTelegram, type Telegram } from './report/telegram.js';
import { initRegimeState, updateRegime, type RegimeState } from './signals/regime.js';
import { updateVolTracker } from './signals/vol.js';
import type {
  BenchmarkState,
  CostInputs,
  Params,
  PoolSnapshot,
  VirtualPosition,
} from './types.js';
import { creditFullRangeFees, initBenchmarks, markBenchmarks } from './virtual/benchmarks.js';
import {
  accrueFees,
  applyCompound,
  applyExit,
  applyRebalance,
  markPosition,
  openPosition,
} from './virtual/position.js';

const MS_PER_MIN = 60_000;

/**
 * The loop only needs "give me a snapshot" from the pool reader. Typing it as
 * an interface keeps `tick` testable without an RPC endpoint.
 */
export type PoolSnapshotSource = Pick<PoolReader, 'snapshot' | 'baseMint' | 'quoteMint'>;

export type LoopState = {
  regime: RegimeState;
  position: VirtualPosition | null;
  benchmarks: BenchmarkState | null;
  lastCumulativeFeeUsd: number | null;
  lastTickTs: number | null;
  consecutiveFailures: number;
  alertedFailure: boolean;
};

export async function main(): Promise<void> {
  const env = loadEnv();
  const rawConfig = loadRawConfig();
  const params = toParams(rawConfig, BINS_PER_CLASSIC_POSITION);

  if (params.poolAddress.trim() === '') {
    throw new Error(
      'config/default.toml: [pool].address is empty. Fill in the DLMM pool to shadow before starting.',
    );
  }

  const prisma = getPrisma(env.DATABASE_URL);
  const telegram = createTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  const reader = await PoolReader.create(env.RPC_URL, params.poolAddress);

  const state = await bootstrap(prisma, params, reader);

  let stopping = false;
  const stop = (signal: string) => {
    log.info(`${signal} received, finishing the current tick then exiting`);
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  log.info(
    `shadow loop starting: pool=${params.poolLabel} interval=${params.snapshotIntervalSec}s ` +
      `nav=$${params.virtualNavUsd} (READ-ONLY — no keys are loaded and none can be)`,
  );

  while (!stopping) {
    const started = Date.now();
    try {
      await tick(prisma, params, reader, telegram, state, env.RPC_URL, started);
      state.consecutiveFailures = 0;
      state.alertedFailure = false;
    } catch (err) {
      state.consecutiveFailures += 1;
      log.error(
        `tick failed (${state.consecutiveFailures} consecutive): ${errorMessage(err)}`,
        err,
      );
      // Never fabricate a snapshot; the tick is simply skipped (§13).
      if (state.consecutiveFailures >= params.maxConsecutiveFailures && !state.alertedFailure) {
        state.alertedFailure = true;
        await telegram.send(
          `⚠️ <b>lp-shadow</b>: ${state.consecutiveFailures} consecutive poll failures.\n` +
            `Last error: ${errorMessage(err)}`,
        );
      }
    }

    try {
      await maybeSendDailyReport(prisma, params, telegram, Date.now());
    } catch (err) {
      log.warn(`daily report failed: ${errorMessage(err)}`);
    }

    const elapsed = Date.now() - started;
    const wait = Math.max(0, params.snapshotIntervalSec * 1000 - elapsed);
    if (!stopping) await sleep(wait);
  }

  await disconnectPrisma();
  log.info('shadow loop stopped');
}

/**
 * Crash-safe boot (§13): reload the virtual position from the last event and
 * re-warm the vol EWMAs and the settle window from stored snapshots, so a
 * restart does not reset the strategy's memory.
 */
export async function bootstrap(
  prisma: PrismaClient,
  params: Params,
  reader: PoolSnapshotSource,
): Promise<LoopState> {
  const state: LoopState = {
    regime: initRegimeState(),
    position: null,
    benchmarks: null,
    lastCumulativeFeeUsd: await readCursor<number>(prisma, CURSOR_CUMULATIVE_FEES),
    lastTickTs: null,
    consecutiveFailures: 0,
    alertedFailure: false,
  };

  const lastEvent = await prisma.virtualPositionEvent.findFirst({
    orderBy: { ts: 'desc' },
    select: { detailJson: true, ts: true },
  });
  if (lastEvent) {
    const restored = deserializePosition(lastEvent.detailJson);
    if (restored) {
      state.position = restored;
      log.info(
        `restored virtual position from ${lastEvent.ts.toISOString()}: ` +
          `status=${restored.status} range=[${restored.lowerBinId}, ${restored.upperBinId}] ` +
          `fees=$${restored.cumFeesQuote.toFixed(2)} costs=$${restored.cumCostsQuote.toFixed(2)}`,
      );
    } else {
      log.warn('last VirtualPositionEvent had no usable position detail; starting fresh');
    }
  }

  state.benchmarks = await readCursor<BenchmarkState>(prisma, CURSOR_BENCHMARK_STATE);

  // Re-warm vol from stored history. A window of 4x the slow half-life is
  // plenty for the EWMA to forget its cold start.
  const warmupMs = Math.max(params.volSlowHalfLifeMin * 4, 240) * MS_PER_MIN;
  const history = await prisma.snapshot.findMany({
    where: { ts: { gte: new Date(Date.now() - warmupMs) } },
    orderBy: { ts: 'asc' },
    select: { ts: true, activePrice: true },
  });
  let regime = state.regime;
  for (const row of history) {
    const price = Number(row.activePrice.toString());
    if (!(price > 0)) continue;
    regime = {
      ...regime,
      vol: updateVolTracker(
        regime.vol,
        row.ts.getTime(),
        price,
        params.volFastHalfLifeMin,
        params.volSlowHalfLifeMin,
      ),
      priceWindow: [...regime.priceWindow, { ts: row.ts.getTime(), price }],
    };
  }
  const settleCutoff = Date.now() - params.settleMin * MS_PER_MIN * 2;
  regime = { ...regime, priceWindow: regime.priceWindow.filter((p) => p.ts >= settleCutoff) };
  state.regime = regime;
  state.lastTickTs = history.at(-1)?.ts.getTime() ?? null;
  log.info(`re-warmed vol EWMAs from ${history.length} stored snapshots`);

  // Touch the reader so a misconfigured pool fails loudly at boot, not an hour in.
  log.debug(`pool base=${reader.baseMint} quote=${reader.quoteMint}`);

  return state;
}

export async function tick(
  prisma: PrismaClient,
  params: Params,
  reader: PoolSnapshotSource,
  telegram: Telegram,
  state: LoopState,
  rpcUrl: string,
  ts: number,
): Promise<void> {
  // ---- poll ---------------------------------------------------------------
  const onChain = await reader.snapshot(ts);

  const [stats, prices, priorityFee] = await Promise.all([
    fetchPoolStats(params.poolAddress).catch((err) => {
      log.warn(`meteora pool stats unavailable: ${errorMessage(err)}`);
      return null as PoolStats | null;
    }),
    fetchUsdPrices([SOL_MINT, onChain.baseMint, onChain.quoteMint]).catch((err) => {
      log.warn(`jupiter price unavailable: ${errorMessage(err)}`);
      return new Map<string, number>();
    }),
    fetchPriorityFee(rpcUrl, [params.poolAddress]),
  ]);

  const elapsedSec =
    state.lastTickTs === null
      ? params.snapshotIntervalSec
      : Math.max(1, (ts - state.lastTickTs) / 1000);

  const feeInterval = stats
    ? intervalFeesUsd(stats, state.lastCumulativeFeeUsd, elapsedSec)
    : { feesUsd: undefined, source: 'none' as const };
  if (stats?.cumulativeTradeFeeUsd !== undefined) {
    state.lastCumulativeFeeUsd = stats.cumulativeTradeFeeUsd;
    await writeCursor(prisma, CURSOR_CUMULATIVE_FEES, stats.cumulativeTradeFeeUsd);
  }

  const quoteUsd = prices.get(onChain.quoteMint) ?? 1;
  const baseUsd = prices.get(onChain.baseMint);
  const jupPrice = baseUsd !== undefined && quoteUsd > 0 ? baseUsd / quoteUsd : undefined;
  const solPriceUsd = prices.get(SOL_MINT) ?? (onChain.baseMint === SOL_MINT ? baseUsd ?? 0 : 0);

  const snapshot: PoolSnapshot = {
    ts,
    activeBinId: onChain.activeBinId,
    activePrice: onChain.activePrice,
    binStepBps: onChain.binStepBps,
    feeBps: onChain.feeBps,
    liqActiveBin: onChain.liqActiveBin,
    liqNearby: onChain.liqNearby,
    poolTvlUsd: stats?.tvlUsd,
    poolVol24hUsd: stats?.vol24hUsd,
    poolFees24hUsd: stats?.fees24hUsd,
    poolFeesIntervalUsd: feeInterval.feesUsd,
    jupPrice,
  };
  state.lastTickTs = ts;

  // ---- signals ------------------------------------------------------------
  const { state: regime, signals } = updateRegime(state.regime, snapshot, params);
  state.regime = regime;

  // ---- open the position on the first usable tick -------------------------
  if (state.position === null) {
    if (!signals.volReliable) {
      log.info(
        `waiting for volatility to be measurable before opening: ` +
          `${signals.volSamples}/${params.volMinSamples} samples`,
      );
      await persistTick(prisma, snapshot, signals, await buildCostInputs(
        params,
        onChain,
        snapshot,
        priorityFee.microLamportsPerCu,
        solPriceUsd,
        quoteUsd,
        params.virtualNavUsd,
        null,
      ));
      return;
    }
    const plan = planRange(snapshot.activeBinId, snapshot.binStepBps, signals, params);
    state.position = openPosition(snapshot, plan.lowerBinId, plan.upperBinId, params.virtualNavUsd);
    state.benchmarks = initBenchmarks(snapshot, params.virtualNavUsd);
    await writeCursor(prisma, CURSOR_BENCHMARK_STATE, state.benchmarks);
    await saveVirtualEvent(
      prisma,
      'OPEN',
      state.position,
      positionNavUsd(state.position, snapshot),
      ts,
      {
        plan,
        volSlowAnnual: signals.volSlowAnnual,
        note: 'virtual open — no transaction was built or sent',
      },
    );
    log.info(
      `virtual position opened: bins [${plan.lowerBinId}, ${plan.upperBinId}] ` +
        `(${plan.binsPerSide * 2 + 1} bins) at price ${snapshot.activePrice}`,
    );
  }

  // ---- mark + accrue ------------------------------------------------------
  let position = markPosition(state.position, snapshot);
  const accrued = accrueFees(position, snapshot);
  position = accrued.position;

  if (state.benchmarks === null) {
    state.benchmarks = initBenchmarks(snapshot, params.virtualNavUsd);
  }
  state.benchmarks = creditFullRangeFees(state.benchmarks, snapshot);

  // ---- decide -------------------------------------------------------------
  const navUsd = positionNavUsd(position, snapshot);
  const costInputs = await buildCostInputs(
    params,
    onChain,
    snapshot,
    priorityFee.microLamportsPerCu,
    solPriceUsd,
    quoteUsd,
    navUsd,
    position,
  );

  const decision = decide(snapshot, position, signals, params, costInputs);

  // ---- apply virtually ----------------------------------------------------
  let applied = false;
  let eventKind: 'COMPOUND' | 'REBALANCE' | 'EXIT' | null = null;
  switch (decision.kind) {
    case 'COMPOUND': {
      position = applyCompound(position, snapshot, estimateCost('COMPOUND', costInputs, params));
      applied = true;
      eventKind = 'COMPOUND';
      break;
    }
    case 'REBALANCE': {
      position = applyRebalance(
        position,
        snapshot,
        decision.newLowerBin,
        decision.newUpperBin,
        decision.costEst,
      );
      applied = true;
      eventKind = 'REBALANCE';
      break;
    }
    case 'EXIT': {
      position = applyExit(position, snapshot, decision.costEst);
      applied = true;
      eventKind = 'EXIT';
      break;
    }
    case 'HOLD':
      break;
  }
  state.position = position;

  // ---- persist ------------------------------------------------------------
  const snapshotId = await persistTick(prisma, snapshot, signals, costInputs);
  await saveDecision(prisma, snapshotId, decision, applied, ts);

  const finalNav = positionNavUsd(position, snapshot);
  if (eventKind) {
    await saveVirtualEvent(prisma, eventKind, position, finalNav, ts, {
      reasons: decision.reasons,
      note: 'virtual only — no transaction was built or sent',
    });
  }
  const inRange =
    position.status === 'ACTIVE' &&
    snapshot.activeBinId >= position.lowerBinId &&
    snapshot.activeBinId <= position.upperBinId;
  await saveVirtualEvent(prisma, 'MARK', position, finalNav, ts, {
    inRange,
    feesTick: accrued.feesTick,
    activeBinShare: accrued.share,
    feeSource: feeInterval.source,
  });

  const marks = markBenchmarks(state.benchmarks, position, snapshot);
  await saveBenchmarkMark(prisma, marks, ts);
  await writeCursor(prisma, CURSOR_BENCHMARK_STATE, state.benchmarks);

  // ---- alerts -------------------------------------------------------------
  if (decision.kind === 'EXIT') {
    await telegram.send(
      `🚨 <b>lp-shadow EXIT</b> (${params.poolLabel})\n` +
        decision.reasons.map((r) => `• ${r}`).join('\n') +
        `\n\nVirtual NAV ${finalNav.toFixed(2)} vs HODL ${marks.hodlNavUsd.toFixed(2)}`,
    );
  }

  if (jupPrice !== undefined && snapshot.activePrice > 0) {
    const divergence = Math.abs(jupPrice - snapshot.activePrice) / snapshot.activePrice;
    if (divergence * 100 > params.priceDivergenceAlertPct) {
      await telegram.send(
        `⚠️ <b>lp-shadow price divergence</b> (${params.poolLabel})\n` +
          `pool ${snapshot.activePrice.toFixed(6)} vs Jupiter ${jupPrice.toFixed(6)} ` +
          `(${(divergence * 100).toFixed(2)}%)`,
      );
    }
  }

  log.info(
    `${decision.kind} bin=${snapshot.activeBinId} price=${snapshot.activePrice.toFixed(6)} ` +
      `nav=$${finalNav.toFixed(2)} hodl=$${marks.hodlNavUsd.toFixed(2)} ` +
      `fees=$${position.cumFeesQuote.toFixed(4)} costs=$${position.cumCostsQuote.toFixed(2)} ` +
      `volSlow=${(signals.volSlowAnnual * 100).toFixed(1)}%`,
  );
}

async function persistTick(
  prisma: PrismaClient,
  snapshot: PoolSnapshot,
  signals: Parameters<typeof saveSnapshot>[2],
  costInputs: CostInputs,
): Promise<bigint> {
  return saveSnapshot(prisma, snapshot, signals, costInputs);
}

/**
 * Prices the hypothetical rebalance swap leg.
 *
 * Direction follows the position's actual imbalance: after a rally the position
 * is sitting in quote and re-centring means buying base, and vice versa. When
 * there is no position yet, quote -> base is assumed.
 *
 * `fetchQuote` only ever hits Jupiter's /quote endpoint. /swap — the endpoint
 * that builds a transaction — is never called from anywhere in this repo.
 */
async function buildCostInputs(
  params: Params,
  onChain: OnChainSnapshot,
  snapshot: PoolSnapshot,
  priorityFeeMicroLamportsPerCu: number,
  solPriceUsd: number,
  quoteUsd: number,
  navUsd: number,
  position: VirtualPosition | null,
): Promise<CostInputs> {
  const swapNotionalUsd = navUsd * params.swapShareOfNav;

  const baseValueUsd = (position?.base ?? 0) * snapshot.activePrice * quoteUsd;
  const quoteValueUsd = (position?.quote ?? 0) * quoteUsd;
  const buyingBase = position === null || quoteValueUsd >= baseValueUsd;

  const inputMint = buyingBase ? onChain.quoteMint : onChain.baseMint;
  const outputMint = buyingBase ? onChain.baseMint : onChain.quoteMint;
  const inputDecimals = buyingBase ? onChain.quoteDecimals : onChain.baseDecimals;
  const outputDecimals = buyingBase ? onChain.baseDecimals : onChain.quoteDecimals;
  const inputUsd = buyingBase ? quoteUsd : snapshot.activePrice * quoteUsd;
  const outputUsd = buyingBase ? snapshot.activePrice * quoteUsd : quoteUsd;

  let swapOutValueUsd: number | null = null;
  let quotePriceImpactPct: number | null = null;
  if (swapNotionalUsd > 0 && inputUsd > 0) {
    try {
      const quote = await fetchQuote({
        inputMint,
        outputMint,
        amount: (swapNotionalUsd / inputUsd) * 10 ** inputDecimals,
        slippageBps: params.quoteSlippageBps,
      });
      swapOutValueUsd = (quote.outAmount / 10 ** outputDecimals) * outputUsd;
      quotePriceImpactPct = quote.priceImpactPct;
    } catch (err) {
      log.warn(`jupiter quote unavailable, cost estimate falls back: ${errorMessage(err)}`);
    }
  }

  // Rent for bin arrays a re-centred range would have to create. Position rent
  // (POSITION_RENT_LAMPORTS) is refundable on close, so it is not charged here.
  const maxPerSide = Math.floor(params.maxTotalBins / 2);
  const newBinArrayRent = newBinArrayRentLamports(
    snapshot.activeBinId - maxPerSide,
    snapshot.activeBinId + maxPerSide,
    onChain.existingBinArrayIndexes,
  );
  void POSITION_RENT_LAMPORTS;

  return {
    swapNotionalUsd,
    swapOutValueUsd,
    quotePriceImpactPct,
    priorityFeeMicroLamportsPerCu,
    solPriceUsd,
    newBinArrayRentLamports: newBinArrayRent,
  };
}

async function maybeSendDailyReport(
  prisma: PrismaClient,
  params: Params,
  telegram: Telegram,
  now: number,
): Promise<void> {
  if (localHour(now, params.reportTimezone) !== params.reportDailyHourLocal) return;
  const dayKey = localDayKey(now, params.reportTimezone);
  const last = await readCursor<string>(prisma, CURSOR_LAST_DAILY_REPORT);
  if (last === dayKey) return;

  const report = await buildDailyReport(prisma, params, now, {
    includeGoLive: isWeeklyReportDay(now, params.reportTimezone),
  });
  await telegram.send(report.text);
  await writeCursor(prisma, CURSOR_LAST_DAILY_REPORT, dayKey);
  log.info(`daily report sent for ${dayKey}`);
}

// Only start the loop when this file is the process entrypoint; importing it
// (from a test, say) must not launch a shadow run.
const invokedDirectly = process.argv[1]?.endsWith('index.ts') === true;
if (invokedDirectly) {
  main().catch(async (err) => {
    log.error(`fatal: ${errorMessage(err)}`, err);
    await disconnectPrisma().catch(() => undefined);
    process.exitCode = 1;
  });
}
