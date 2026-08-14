import 'dotenv/config';
import { loadRawConfig, toParams } from '../src/config.js';
import { fetchPoolOhlcvRange, fetchPoolStats, type PoolStats } from '../src/poller/meteoraApi.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import {
  evaluateProfiles,
  evaluateTreasuryCandidate,
  fillOhlcvGaps,
  historicalScenarioFromOhlcv,
  lockTreasuryCandidate,
  lockPolicyCandidate,
  rankPolicyCandidates,
  runPolicyCandidate,
  evaluatePolicyCandidate,
  type ExperimentalPolicyScore,
  type ExperimentalPolicyScenarioResult,
  type ExperimentalPolicyCandidate,
  type ProfileScenarioResult,
  type StrategyScenario,
  type TreasuryCandidateScore,
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

function printReplay(rows: ProfileScenarioResult[], loaded: LoadedLaunch[]) {
  const launchByName = new Map(loaded.map((launch) => [launch.name, launch]));
  printTable([
    ['cohort', (row) => launchByName.get(row.scenario)?.cohort ?? '?'],
    ['stratum', (row) => launchByName.get(row.scenario)?.stratum ?? '?'],
    ['launch', (row) => row.scenario],
    ['profile', (row) => row.profileSlug],
    ['net/HODL', (row) => row.replay.netVsHodlUsd.toFixed(0)],
    ['max DD', (row) => `${(row.replay.maxDrawdownPct * 100).toFixed(1)}%`],
    ['fees*', (row) => row.replay.totalFeesUsd.toFixed(0)],
    ['rebal', (row) => String(row.replay.rebalances)],
    ['reserve', (row) => `${(row.replay.finalReserveSharePct * 100).toFixed(1)}%`],
  ], rows);

  process.stdout.write('\nCohort averages for the unchanged built-in profiles:\n');
  for (const cohort of ['TRAINING', 'HOLDOUT'] as const) {
    for (const profileSlug of ['fee-maximizer', 'market-depth', 'treasury-defensive'] as const) {
      const group = rows.filter((row) =>
        launchByName.get(row.scenario)?.cohort === cohort && row.profileSlug === profileSlug,
      );
      const average = (get: (row: ProfileScenarioResult) => number) =>
        group.reduce((sum, row) => sum + get(row), 0) / group.length;
      process.stdout.write(
        `${`${cohort}:${profileSlug}`.padEnd(36)} ` +
        `net/HODL ${average((row) => row.replay.netVsHodlUsd).toFixed(0).padStart(8)} ` +
        `maxDD ${(average((row) => row.replay.maxDrawdownPct) * 100).toFixed(1).padStart(5)}% ` +
        `rebal ${average((row) => row.replay.rebalances).toFixed(1).padStart(4)}\n`,
      );
    }
  }
}

function printTuning(scores: TreasuryCandidateScore[], holdout: TreasuryCandidateScore) {
  process.stdout.write('\nTraining-only Treasury Defensive quote-exposure sweep:\n');
  printTable([
    ['quote', (row) => `${(row.candidate.deployedQuoteShare * 100).toFixed(0)}%`],
    ['median net/HODL', (row) => row.medianNetVsHodlUsd.toFixed(0)],
    ['average', (row) => row.averageNetVsHodlUsd.toFixed(0)],
    ['worst', (row) => row.worstNetVsHodlUsd.toFixed(0)],
    ['max DD', (row) => `${(row.averageMaxDrawdownPct * 100).toFixed(1)}%`],
    ['rebal', (row) => row.averageRebalances.toFixed(1)],
  ], scores);
  process.stdout.write(
    `\nLocked ${holdout.candidate.name} before holdout: ` +
    `holdout median net/HODL ${holdout.medianNetVsHodlUsd.toFixed(0)}, ` +
    `average ${holdout.averageNetVsHodlUsd.toFixed(0)}, ` +
    `worst ${holdout.worstNetVsHodlUsd.toFixed(0)}, ` +
    `average max DD ${(holdout.averageMaxDrawdownPct * 100).toFixed(1)}%.\n`,
  );
}

function printPolicyExperiment(
  scores: ExperimentalPolicyScore[],
  holdout: ExperimentalPolicyScore,
  holdoutRows: ExperimentalPolicyScenarioResult[],
  ablations: ExperimentalPolicyScore[],
  loaded: LoadedLaunch[],
) {
  process.stdout.write('\nStructural policy experiment — top 10 training candidates of 64:\n');
  printTable([
    ['delay', (row) => `${row.candidate.entryDelayHours}h`],
    ['inventory', (row) => row.candidate.inventory],
    ['exit', (row) => row.candidate.exit],
    ['median net/HODL', (row) => row.medianNetVsHodlUsd.toFixed(0)],
    ['average', (row) => row.averageNetVsHodlUsd.toFixed(0)],
    ['worst', (row) => row.worstNetVsHodlUsd.toFixed(0)],
    ['max DD', (row) => `${(row.averageMaxDrawdownPct * 100).toFixed(1)}%`],
    ['fees', (row) => row.averageFeesUsd.toFixed(0)],
    ['exited', (row) => `${(row.exitRate * 100).toFixed(0)}%`],
  ], rankPolicyCandidates(scores).slice(0, 10));
  process.stdout.write(
    `\nLocked ${holdout.candidate.name} before holdout: ` +
    `median net/HODL ${holdout.medianNetVsHodlUsd.toFixed(0)}, ` +
    `average ${holdout.averageNetVsHodlUsd.toFixed(0)}, ` +
    `worst ${holdout.worstNetVsHodlUsd.toFixed(0)}, ` +
    `average max DD ${(holdout.averageMaxDrawdownPct * 100).toFixed(1)}%, ` +
    `exit rate ${(holdout.exitRate * 100).toFixed(0)}%.\n`,
  );
  const launchByName = new Map(loaded.map((launch) => [launch.name, launch]));
  process.stdout.write('\nLocked policy by holdout launch:\n');
  printTable([
    ['stratum', (row) => launchByName.get(row.scenario)?.stratum ?? '?'],
    ['launch', (row) => row.scenario],
    ['net/HODL', (row) => row.replay.netVsHodlUsd.toFixed(0)],
    ['max DD', (row) => `${(row.replay.maxDrawdownPct * 100).toFixed(1)}%`],
    ['fees', (row) => row.replay.totalFeesUsd.toFixed(0)],
    ['exited', (row) => row.replay.exited ? 'yes' : 'no'],
  ], holdoutRows);
  process.stdout.write('\nHoldout component ablations (same launch-time benchmark):\n');
  printTable([
    ['candidate', (row) => row.candidate.name],
    ['median net/HODL', (row) => row.medianNetVsHodlUsd.toFixed(0)],
    ['average', (row) => row.averageNetVsHodlUsd.toFixed(0)],
    ['worst', (row) => row.worstNetVsHodlUsd.toFixed(0)],
    ['max DD', (row) => `${(row.averageMaxDrawdownPct * 100).toFixed(1)}%`],
  ], ablations);
}

async function main() {
  process.stdout.write('Historical strategy lab — frozen 24-launch Meteora stress cohort\n');
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

  process.stdout.write(`\n${loaded.reduce((sum, launch) => sum + launch.candles.length, 0)} historical candles loaded.\n`);
  process.stdout.write(`Every replay uses the same explicit $${MODELED_TVL_USD.toLocaleString()} modeled TVL.\n\n`);
  const profileResults = evaluateProfiles(params, scenarios);
  printReplay(profileResults, loaded);

  const locked = lockTreasuryCandidate(params, cohortScenarios('TRAINING'));
  const holdout = evaluateTreasuryCandidate(params, cohortScenarios('HOLDOUT'), locked.candidate);
  printTuning(locked.trainingScores, holdout);

  const lockedPolicy = lockPolicyCandidate(params, cohortScenarios('TRAINING'));
  const policyHoldout = evaluatePolicyCandidate(
    params,
    cohortScenarios('HOLDOUT'),
    lockedPolicy.candidate,
  );
  const holdoutPolicyScenarios = cohortScenarios('HOLDOUT');
  const ablationCandidates: ExperimentalPolicyCandidate[] = [
    { ...lockedPolicy.candidate, name: 'locked' },
    { ...lockedPolicy.candidate, name: 'no-delay', entryDelayHours: 0 },
    { ...lockedPolicy.candidate, name: 'no-explicit-exit', exit: 'NONE' },
    { ...lockedPolicy.candidate, name: 'balanced-inventory', inventory: 'BALANCED' },
  ];
  printPolicyExperiment(
    lockedPolicy.trainingScores,
    policyHoldout,
    runPolicyCandidate(params, holdoutPolicyScenarios, lockedPolicy.candidate),
    ablationCandidates.map((candidate) =>
      evaluatePolicyCandidate(params, holdoutPolicyScenarios, candidate),
    ),
    loaded,
  );

  process.stdout.write('\nEvidence boundary:\n');
  process.stdout.write('- Prices and volumes are observed Meteora candles; intracandle paths are unavailable.\n');
  process.stdout.write('- Missing intervals after the first trade are modeled as flat, zero-volume inactivity.\n');
  process.stdout.write('- Historical TVL, per-bin liquidity, dynamic fees, and Jupiter routes are unavailable.\n');
  process.stdout.write('- Fees use volume × base fee; liquidity uses fixed modeled TVL; swaps use 50 bps impact.\n');
  process.stdout.write('- Structural policies charge 50 bps on starting cash converted into base at entry.\n');
  process.stdout.write('- The stress cohort is outcome-stratified and not a representative population estimate.\n');
  process.stdout.write('- The locked candidate remains experimental; this command does not change production profiles.\n');
}

await main();
