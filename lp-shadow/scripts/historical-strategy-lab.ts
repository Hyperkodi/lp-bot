import 'dotenv/config';
import { loadRawConfig, toParams } from '../src/config.js';
import { fetchQuote, fetchUsdPrices } from '../src/poller/jupiter.js';
import {
  fetchPoolOhlcvRange,
  fetchPoolStats,
  type PoolStats,
} from '../src/poller/meteoraApi.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import {
  evaluateProfiles,
  historicalScenarioFromOhlcv,
  type ProfileScenarioResult,
} from '../src/strategy/index.js';

type Cohort = 'TRAINING' | 'HOLDOUT';
type Launch = { cohort: Cohort; address: string };

const LAUNCHES: Launch[] = [
  { cohort: 'TRAINING', address: '7iyWwX51LwktZoYbwjndBGwX98VYm3pqNRGoZLw1tB3s' },
  { cohort: 'TRAINING', address: '48M3tRdbVYmEbf5rCTFVAgqCCaZdChVmeg3VPBrmgT8m' },
  { cohort: 'TRAINING', address: 'AUaPMKd13d633cXRRrPRfTeL5XRN64ngDWLEfH5zfBML' },
  { cohort: 'HOLDOUT', address: 'EAf6shtt8QGJ7UiSRrDc6pzwXKEmb5s7tCCpSDe5zpzZ' },
  { cohort: 'HOLDOUT', address: 'FXc1BVyNDmqwSKbYD8JwMGq5uqsUov4BCjqnATAeyARk' },
  { cohort: 'HOLDOUT', address: '68C62WPYiiNZxprbuaMj2ULXpiTDKcs5xsX7kBGnyajR' },
];

type LoadedLaunch = Launch & { stats: PoolStats; candles: Awaited<ReturnType<typeof fetchPoolOhlcvRange>> };

function requireMetadata(stats: PoolStats, address: string) {
  if (
    !stats.createdAtMs ||
    !stats.binStepBps ||
    !stats.tvlUsd ||
    stats.baseFeePct === undefined ||
    !stats.baseMint ||
    stats.baseDecimals === undefined ||
    !stats.quoteMint ||
    stats.quoteDecimals === undefined
  ) {
    throw new Error(`pool ${address} is missing historical-lab metadata`);
  }
}

async function loadLaunch(launch: Launch): Promise<LoadedLaunch> {
  const stats = await fetchPoolStats(launch.address);
  requireMetadata(stats, launch.address);
  const start = Math.floor(stats.createdAtMs! / 1_000 / 300) * 300;
  const end = start + 72 * 60 * 60;
  const candles = await fetchPoolOhlcvRange(launch.address, '5m', start, end);
  if (candles.length < 21) throw new Error(`${stats.name ?? launch.address} returned only ${candles.length} candles`);
  return { ...launch, stats, candles };
}

function printReplay(rows: ProfileScenarioResult[], loaded: LoadedLaunch[]) {
  const cohortByScenario = new Map(
    loaded.map((launch) => [`${launch.stats.name}:${launch.address.slice(0, 6)}`, launch.cohort]),
  );
  const columns: [string, (row: ProfileScenarioResult) => string][] = [
    ['cohort', (row) => cohortByScenario.get(row.scenario) ?? '?'],
    ['launch', (row) => row.scenario.split(':')[0]!],
    ['profile', (row) => row.profileSlug],
    ['net/HODL', (row) => row.replay.netVsHodlUsd.toFixed(0)],
    ['max DD', (row) => `${(row.replay.maxDrawdownPct * 100).toFixed(1)}%`],
    ['fees*', (row) => row.replay.totalFeesUsd.toFixed(0)],
    ['rebal', (row) => String(row.replay.rebalances)],
    ['base', (row) => `${(row.replay.finalBaseSharePct * 100).toFixed(1)}%`],
    ['reserve', (row) => `${(row.replay.finalReserveSharePct * 100).toFixed(1)}%`],
  ];
  printTable(columns, rows);

  const grouped = new Map<string, ProfileScenarioResult[]>();
  for (const row of rows) {
    const key = `${cohortByScenario.get(row.scenario)}:${row.profileSlug}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  process.stdout.write('\nCohort averages (descriptive only; no parameter selection):\n');
  for (const [key, group] of grouped) {
    const average = (get: (row: ProfileScenarioResult) => number) =>
      group.reduce((sum, row) => sum + get(row), 0) / group.length;
    process.stdout.write(
      `${key.padEnd(36)} net/HODL ${average((row) => row.replay.netVsHodlUsd).toFixed(0).padStart(6)} ` +
      `maxDD ${(average((row) => row.replay.maxDrawdownPct) * 100).toFixed(1).padStart(5)}% ` +
      `rebal ${average((row) => row.replay.rebalances).toFixed(1).padStart(4)}\n`,
    );
  }
}

async function printLiveQuotes(loaded: LoadedLaunch[]) {
  const mints = loaded.flatMap(({ stats }) => [stats.baseMint!, stats.quoteMint!]);
  const prices = await fetchUsdPrices(mints);
  process.stdout.write('\nLive Jupiter quote cross-check (read-only, current routes; not historical):\n');
  process.stdout.write(' launch  order  reported impact  exact pool  route\n');
  process.stdout.write('-------  -----  ---------------  ----------  -----\n');
  for (const { address, stats } of loaded) {
    const quoteUsd = prices.get(stats.quoteMint!);
    if (!(quoteUsd && quoteUsd > 0)) {
      process.stdout.write(`${(stats.name ?? '?').padStart(7)}  skipped: no current Jupiter quote-token price\n`);
      continue;
    }
    for (const notionalUsd of [100, 500, 1_000]) {
      try {
        const quote = await fetchQuote({
          inputMint: stats.quoteMint!,
          outputMint: stats.baseMint!,
          amount: (notionalUsd / quoteUsd) * 10 ** stats.quoteDecimals!,
          slippageBps: 50,
        });
        const impact = quote.priceImpactPct === null ? 'unavailable' : `${(quote.priceImpactPct * 100).toFixed(3)}%`;
        const exactPool = quote.routeAmmKeys.includes(address) ? 'yes' : 'no';
        process.stdout.write(
          `${(stats.name ?? '?').padStart(7)}  ${String(notionalUsd).padStart(5)}  ${impact.padStart(15)}  ${exactPool.padStart(10)}  ${quote.routeLabels.join(' > ')}\n`,
        );
      } catch (error) {
        process.stdout.write(
          `${(stats.name ?? '?').padStart(7)}  ${String(notionalUsd).padStart(5)}  failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
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

async function main() {
  process.stdout.write('Historical strategy lab — six real Meteora launch paths\n');
  process.stdout.write('Fetching each pool\'s first 72 hours of 5-minute OHLCV...\n');
  const loaded: LoadedLaunch[] = [];
  for (const launch of LAUNCHES) {
    const row = await loadLaunch(launch);
    loaded.push(row);
    process.stdout.write(`- ${launch.cohort} ${row.stats.name}: ${row.candles.length} candles\n`);
  }

  const scenarios = loaded.map(({ address, stats, candles }) => historicalScenarioFromOhlcv(
    `${stats.name}:${address.slice(0, 6)}`,
    candles,
    stats,
    {
      currentTvlUsd: stats.tvlUsd!,
      baseFeePct: stats.baseFeePct!,
      virtualRangeBins: BINS_PER_CLASSIC_POSITION - 1,
      swapFallbackImpactBps: 50,
    },
  ));
  const params = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);
  const results = evaluateProfiles(params, scenarios);
  process.stdout.write('\nHistorical-close replay with explicitly modeled unavailable inputs:\n');
  printReplay(results, loaded);
  process.stdout.write('\n* Fee results are proxy estimates: historical volume x base fee, current TVL held constant.\n');
  process.stdout.write('* Historical per-bin liquidity, dynamic fees, and Jupiter routes are unavailable.\n');
  process.stdout.write('* Training/holdout labels prevent tuning on every launch, but this six-pool sample is not approval evidence.\n');
  await printLiveQuotes(loaded);
  process.stdout.write('\nAn exact-pool "no" means Jupiter found another venue or another pool; it is not evidence about this pool\'s depth.\n');
}

await main();
