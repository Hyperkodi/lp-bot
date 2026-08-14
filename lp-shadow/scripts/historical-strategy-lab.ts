import 'dotenv/config';
import { loadRawConfig, toParams } from '../src/config.js';
import { fetchPoolOhlcvRange, fetchPoolStats, type PoolStats } from '../src/poller/meteoraApi.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import {
  evaluateInitialLiquidityCandidate,
  fillOhlcvGaps,
  historicalScenarioFromOhlcv,
  initialLiquidityCandidates,
  runInitialLiquidityCandidate,
  selectInitialLiquidityOptions,
  type InitialLiquidityScore,
  type StrategyScenario,
} from '../src/strategy/index.js';
import {
  HISTORICAL_LAUNCHES,
  type HistoricalLaunch,
} from '../src/strategy/historicalManifest.js';

const MODELED_TVL_USD = 100_000;
const MINIMUM_OBSERVED_CANDLES = 21;
type LoadedLaunch = HistoricalLaunch & {
  stats: PoolStats;
  candles: Awaited<ReturnType<typeof fetchPoolOhlcvRange>>;
  observedCandles: number;
};

type Objective = 'capital' | 'fees' | 'buyerDepth' | 'durability';

function requireMetadata(stats: PoolStats, launch: HistoricalLaunch) {
  if (!stats.binStepBps || stats.baseFeePct === undefined) {
    throw new Error(`${launch.name} (${launch.address}) is missing bin-step or base-fee metadata`);
  }
}

async function loadLaunch(launch: HistoricalLaunch): Promise<LoadedLaunch> {
  const stats = await fetchPoolStats(launch.address);
  requireMetadata(stats, launch);
  const start = Math.floor(launch.createdAtMs / 1_000 / 1_800) * 1_800;
  const end = start + 72 * 60 * 60;
  const observed = await fetchPoolOhlcvRange(launch.address, '30m', start, end);
  if (observed.length < MINIMUM_OBSERVED_CANDLES) {
    throw new Error(
      `${launch.name} returned ${observed.length}; requires ${MINIMUM_OBSERVED_CANDLES} observed candles`,
    );
  }
  const candles = fillOhlcvGaps(observed, start, end, 1_800);
  return { ...launch, stats, candles, observedCandles: observed.length };
}

function printTable<T>(columns: [string, (row: T) => string][], rows: T[]) {
  const widths = columns.map(([heading, render]) =>
    Math.max(heading.length, ...rows.map((row) => render(row).length)),
  );
  const line = (cells: string[]) => cells.map((cell, index) => cell.padStart(widths[index]!)).join('  ');
  process.stdout.write(`${line(columns.map(([heading]) => heading))}\n`);
  process.stdout.write(`${line(widths.map((width) => '-'.repeat(width)))}\n`);
  for (const row of rows) process.stdout.write(`${line(columns.map(([, render]) => render(row)))}\n`);
}

function printOptions(rows: { objective: Objective; training: InitialLiquidityScore; holdout: InitialLiquidityScore }[]) {
  process.stdout.write('\nTraining-selected permanent initial-liquidity options and locked holdout results:\n');
  printTable([
    ['objective', (row) => row.objective],
    ['shape', (row) => row.training.candidate.distributionShape],
    ['inventory', (row) => row.training.candidate.inventory],
    ['bins', (row) => String(row.training.candidate.totalBins)],
    ['train median', (row) => row.training.medianNetVsHodlUsd.toFixed(0)],
    ['hold median', (row) => row.holdout.medianNetVsHodlUsd.toFixed(0)],
    ['hold average', (row) => row.holdout.averageNetVsHodlUsd.toFixed(0)],
    ['hold worst', (row) => row.holdout.worstNetVsHodlUsd.toFixed(0)],
    ['hold fees', (row) => row.holdout.averageFeesUsd.toFixed(0)],
    ['in range', (row) => `${(row.holdout.averageTimeInRange * 100).toFixed(1)}%`],
    ['launch depth', (row) => row.holdout.averageInitialBuyerDepth1PctUsd.toFixed(0)],
    ['launch fill', (row) => `${(row.holdout.averageInitialBuyerFillRate * 100).toFixed(1)}%`],
    ['72h depth', (row) => row.holdout.averageBuyerDepth1PctUsd.toFixed(0)],
    ['max DD', (row) => `${(row.holdout.averageMaxDrawdownPct * 100).toFixed(1)}%`],
  ], rows);
}

function assertPermanent(
  params: Parameters<typeof runInitialLiquidityCandidate>[0],
  scenarios: StrategyScenario[],
  score: InitialLiquidityScore,
) {
  const rows = runInitialLiquidityCandidate(params, scenarios, score.candidate);
  for (const row of rows) {
    if (row.replay.exited || row.replay.rebalances !== 0 || row.replay.compounds !== 0) {
      throw new Error(`${score.candidate.name} managed or withdrew ${row.scenario}`);
    }
  }
}

async function main() {
  process.stdout.write('Initial liquidity lab — permanent launch positions across 24 Meteora paths\n');
  process.stdout.write('Fetching each pool\'s first 72 hours of 30-minute OHLCV...\n');
  const loaded: LoadedLaunch[] = [];
  for (const launch of HISTORICAL_LAUNCHES) {
    const row = await loadLaunch(launch);
    loaded.push(row);
    process.stdout.write(
      `- ${launch.cohort.padEnd(8)} ${launch.stratum.padEnd(6)} ${launch.name}: ` +
      `${row.observedCandles} observed, ${row.candles.length - row.observedCandles} inactive fills\n`,
    );
  }

  const scenarios = loaded.map(({ name, stats, candles }) => historicalScenarioFromOhlcv(
    name,
    candles,
    stats,
    {
      modeledTvlUsd: MODELED_TVL_USD,
      baseFeePct: stats.baseFeePct!,
      virtualRangeBins: BINS_PER_CLASSIC_POSITION - 1,
      swapFallbackImpactBps: 50,
    },
  ));
  const scenarioByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));
  const cohortScenarios = (cohort: HistoricalLaunch['cohort']): StrategyScenario[] =>
    loaded
      .filter((launch) => launch.cohort === cohort)
      .map((launch) => scenarioByName.get(launch.name)!);
  const params = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);
  const trainingScenarios = cohortScenarios('TRAINING');
  const holdoutScenarios = cohortScenarios('HOLDOUT');

  process.stdout.write(`\n${loaded.reduce((sum, launch) => sum + launch.candles.length, 0)} replay candles loaded.\n`);
  process.stdout.write('Evaluating 48 launch-time positions: 4 inventory mixes × 3 shapes × 4 widths.\n');
  process.stdout.write('Every position opens immediately and remains untouched for the full replay.\n');

  const trainingScores = initialLiquidityCandidates().map((candidate) =>
    evaluateInitialLiquidityCandidate(params, trainingScenarios, candidate),
  );
  const selected = selectInitialLiquidityOptions(trainingScores);
  const rows = (Object.entries(selected) as [Objective, InitialLiquidityScore][]).map(
    ([objective, training]) => ({
      objective,
      training,
      holdout: evaluateInitialLiquidityCandidate(params, holdoutScenarios, training.candidate),
    }),
  );
  for (const row of rows) assertPermanent(params, holdoutScenarios, row.holdout);
  printOptions(rows);

  process.stdout.write('\nEvidence boundary:\n');
  process.stdout.write('- Each HODL benchmark starts with the same token/SOL mix as its LP candidate.\n');
  process.stdout.write('- Initial inventory is assumed already available; no opening acquisition swap is modeled.\n');
  process.stdout.write('- Positions never compound, rebalance, exit, or withdraw during the 72-hour replay.\n');
  process.stdout.write('- Prices and volumes are historical; missing intervals are flat zero-volume inactivity.\n');
  process.stdout.write('- TVL and per-bin liquidity are modeled; dynamic fees and historical routes are unavailable.\n');
  process.stdout.write('- No production option is selected; the four objectives expose founder tradeoffs.\n');
}

await main();
