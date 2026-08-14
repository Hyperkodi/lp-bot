import { loadRawConfig, toParams } from '../src/config.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import {
  evaluateProfiles,
  syntheticStrategyScenarios,
  type ProfileScenarioResult,
} from '../src/strategy/index.js';

const results = evaluateProfiles(
  toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION),
  syntheticStrategyScenarios(),
);

if (process.argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify(
      results.map((result) => ({
        scenario: result.scenario,
        evidence: result.evidence,
        profile: result.profileSlug,
        shape: result.distributionShape,
        binStepBps: result.binStepBps,
        ...result.replay,
        events: undefined,
      })),
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write('Strategy lab — deterministic synthetic stress suite\n');
  process.stdout.write('These results are engineering checks, not historical evidence or launch approval.\n\n');
  printResults(results);
  process.stdout.write('\nBuyer experience (10% of initial strategy NAV, strategy-owned bins only):\n');
  printBuyerResults(results);
  process.stdout.write('\nKnown evidence gaps:\n');
  process.stdout.write('- This synthetic suite is engineering-only; run strategy:historical for launch evidence.\n');
  process.stdout.write('- Buyer depth excludes other LPs, swap fees, routing, and market reaction.\n');
  process.stdout.write('- Treasury Defensive\'s unchanged 15% quote exposure is not a production recommendation.\n');
  process.stdout.write('- Re-binning isolates bin-step behavior but assumes unchanged fees, volume, and outside liquidity.\n');
  process.stdout.write('\nNo winning profile is selected from synthetic data.\n');
}

function printResults(rows: ProfileScenarioResult[]) {
  const columns: [string, (row: ProfileScenarioResult) => string][] = [
    ['scenario', (row) => row.scenario],
    ['profile', (row) => row.profileSlug],
    ['shape', (row) => row.distributionShape],
    ['step', (row) => String(row.binStepBps)],
    ['net/HODL', (row) => row.replay.netVsHodlUsd.toFixed(2)],
    ['fees', (row) => row.replay.totalFeesUsd.toFixed(2)],
    ['costs', (row) => row.replay.totalCostsUsd.toFixed(2)],
    ['max DD', (row) => `${(row.replay.maxDrawdownPct * 100).toFixed(1)}%`],
    ['in range', (row) => `${(row.replay.timeInRange * 100).toFixed(1)}%`],
    ['rebal', (row) => String(row.replay.rebalances)],
    ['guarded', (row) => String(row.replay.suppressedRebalances)],
    ['base', (row) => `${(row.replay.finalBaseSharePct * 100).toFixed(1)}%`],
    ['reserve', (row) => `${(row.replay.finalReserveSharePct * 100).toFixed(1)}%`],
    ['initial q-risk', (row) => row.replay.initialQuoteAtRiskUsd.toFixed(0)],
    ['cum q->base', (row) => row.replay.cumulativeQuoteConvertedToBaseUsd.toFixed(0)],
  ];
  const widths = columns.map(([heading, render]) =>
    Math.max(heading.length, ...rows.map((row) => render(row).length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padStart(widths[index]!)).join('  ');
  process.stdout.write(`${line(columns.map(([heading]) => heading))}\n`);
  process.stdout.write(`${line(widths.map((width) => '-'.repeat(width)))}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map(([, render]) => render(row)))}\n`);
  }
}

function printBuyerResults(rows: ProfileScenarioResult[]) {
  const columns: [string, (row: ProfileScenarioResult) => string][] = [
    ['scenario', (row) => row.scenario],
    ['profile', (row) => row.profileSlug],
    ['order', (row) => row.replay.buyerOrderUsd.toFixed(0)],
    ['avg depth <=1%', (row) => row.replay.averageBuyDepth1PctUsd.toFixed(0)],
    ['min depth <=1%', (row) => row.replay.minimumBuyDepth1PctUsd.toFixed(0)],
    ['fill', (row) => `${(row.replay.buyerOrderFillRate * 100).toFixed(1)}%`],
    ['avg slip on fills', (row) => `${row.replay.averageBuyerSlippageBps.toFixed(1)}bp`],
  ];
  const widths = columns.map(([heading, render]) =>
    Math.max(heading.length, ...rows.map((row) => render(row).length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padStart(widths[index]!)).join('  ');
  process.stdout.write(`${line(columns.map(([heading]) => heading))}\n`);
  process.stdout.write(`${line(widths.map((width) => '-'.repeat(width)))}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map(([, render]) => render(row)))}\n`);
  }
}
