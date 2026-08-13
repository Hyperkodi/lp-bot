/**
 * The daily report and the advisory go-live gate (§12).
 *
 * Reads the ledger; composes text. Nothing here decides anything.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Params } from '../types.js';
import { escapeHtml } from './telegram.js';

const MS_PER_DAY = 86_400_000;

function usd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function signedPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`;
}

function toNum(value: unknown): number {
  if (value === null || value === undefined) return NaN;
  return Number(value.toString());
}

export type GoLiveVerdict = {
  shadowDays: number;
  hasRegimeChange: boolean;
  regimeRatio: number;
  beatsHodl: boolean;
  pass: boolean;
  lines: string[];
};

/**
 * All three conditions must hold before the verdict flips. Until then the
 * report says KEEP SHADOWING, every day, without exception.
 */
export async function evaluateGoLive(
  prisma: PrismaClient,
  params: Params,
  now: number,
): Promise<GoLiveVerdict> {
  const first = await prisma.snapshot.findFirst({ orderBy: { ts: 'asc' }, select: { ts: true } });
  const shadowDays = first ? (now - first.ts.getTime()) / MS_PER_DAY : 0;

  // Regime change: the slow-vol series doubling or halving anywhere inside the
  // shadow window. Sampled hourly so a single spiky tick cannot fake it.
  const volRows = await prisma.$queryRaw<{ bucket: Date; vol: unknown }[]>`
    SELECT date_trunc('hour', "ts") AS bucket, avg("volSlow") AS vol
    FROM "Snapshot"
    WHERE "volSlow" IS NOT NULL AND "volSlow" > 0
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  const vols = volRows.map((row) => toNum(row.vol)).filter((v) => Number.isFinite(v) && v > 0);
  const maxVol = vols.length > 0 ? Math.max(...vols) : 0;
  const minVol = vols.length > 0 ? Math.min(...vols) : 0;
  const regimeRatio = minVol > 0 ? maxVol / minVol : 0;
  const hasRegimeChange = regimeRatio >= params.goLiveRegimeChangeRatio;

  const latest = await prisma.benchmarkMark.findFirst({ orderBy: { ts: 'desc' } });
  const strategyUsd = latest ? toNum(latest.strategyUsd) : 0;
  const hodlUsd = latest ? toNum(latest.hodlNavUsd) : 0;
  const beatsHodl = latest !== null && strategyUsd > hodlUsd;

  const pass = shadowDays >= params.goLiveMinShadowDays && hasRegimeChange && beatsHodl;

  return {
    shadowDays,
    hasRegimeChange,
    regimeRatio,
    beatsHodl,
    pass,
    lines: [
      `${shadowDays >= params.goLiveMinShadowDays ? '✅' : '❌'} shadow window ` +
        `${shadowDays.toFixed(1)}d / ${params.goLiveMinShadowDays}d`,
      `${hasRegimeChange ? '✅' : '❌'} vol regime change: slow-vol max/min ` +
        `${regimeRatio.toFixed(2)}x / ${params.goLiveRegimeChangeRatio}x`,
      `${beatsHodl ? '✅' : '❌'} strategy ${usd(strategyUsd)} vs HODL ${usd(hodlUsd)} ` +
        `(net of estimated costs)`,
    ],
  };
}

export type DailyReport = {
  text: string;
  verdictPass: boolean;
};

export async function buildDailyReport(
  prisma: PrismaClient,
  params: Params,
  now: number,
  opts: { includeGoLive: boolean },
): Promise<DailyReport> {
  const since = new Date(now - MS_PER_DAY);

  const [latestSnapshot, latestMark, latestEvent, decisions, marks] = await Promise.all([
    prisma.snapshot.findFirst({ orderBy: { ts: 'desc' } }),
    prisma.benchmarkMark.findFirst({ orderBy: { ts: 'desc' } }),
    prisma.virtualPositionEvent.findFirst({ orderBy: { ts: 'desc' } }),
    prisma.decision.findMany({
      where: { ts: { gte: since } },
      orderBy: { ts: 'asc' },
      select: { ts: true, kind: true, reasonsJson: true, applied: true },
    }),
    prisma.virtualPositionEvent.findMany({
      where: { ts: { gte: since }, kind: 'MARK' },
      orderBy: { ts: 'asc' },
      select: { detailJson: true },
    }),
  ]);

  const lines: string[] = [];
  lines.push(`<b>lp-shadow — ${escapeHtml(params.poolLabel)}</b>`);
  lines.push(`<i>Phase 1 shadow mode: no keys, no signing, no funds.</i>`);
  lines.push('');

  if (!latestSnapshot || !latestMark || !latestEvent) {
    lines.push('No data yet — the loop has not completed a full tick.');
    return { text: lines.join('\n'), verdictPass: false };
  }

  const strategyUsd = toNum(latestMark.strategyUsd);
  const hodlUsd = toNum(latestMark.hodlNavUsd);
  const fullRangeUsd = toNum(latestMark.fullRangeUsd);
  const vsHodl = strategyUsd - hodlUsd;
  const vsFullRange = strategyUsd - fullRangeUsd;

  lines.push('<b>NAV</b>');
  lines.push(`strategy    ${usd(strategyUsd)}`);
  lines.push(
    `vs HODL     ${usd(vsHodl)} (${signedPct(hodlUsd > 0 ? vsHodl / hodlUsd : 0)})`,
  );
  lines.push(
    `vs full-rng ${usd(vsFullRange)} (${signedPct(fullRangeUsd > 0 ? vsFullRange / fullRangeUsd : 0)})` +
      ` <i>proxy, crude</i>`,
  );
  lines.push('');

  lines.push('<b>Virtual P&amp;L</b>');
  lines.push(`fees accrued  ${usd(toNum(latestEvent.feesAccruedQ))}`);
  lines.push(`costs paid    ${usd(toNum(latestEvent.costsPaidQ))}`);
  lines.push('');

  const inRangeTicks = marks.filter((row) => {
    const detail = row.detailJson as Record<string, unknown> | null;
    return detail?.inRange === true;
  }).length;
  const timeInRange = marks.length > 0 ? inRangeTicks / marks.length : 0;

  const activePrice = toNum(latestSnapshot.activePrice);
  const lower = latestEvent.lowerBinId;
  const upper = latestEvent.upperBinId;
  lines.push('<b>Position</b>');
  if (lower === null || upper === null) {
    lines.push('status      EXITED');
  } else {
    lines.push(`range       bins [${lower}, ${upper}]`);
    lines.push(
      `price       ${activePrice.toFixed(6)} at bin ${latestSnapshot.activeBinId}` +
        `${latestSnapshot.activeBinId < lower || latestSnapshot.activeBinId > upper ? ' <b>(OUT OF RANGE)</b>' : ''}`,
    );
  }
  lines.push(`time in rng ${pct(timeInRange)} over ${marks.length} marks (24h)`);
  lines.push('');

  lines.push('<b>Pool</b>');
  const tvl = toNum(latestSnapshot.poolTvlUsd);
  const vol24 = toNum(latestSnapshot.poolVol24hUsd);
  const fees24 = toNum(latestSnapshot.poolFees24hUsd);
  lines.push(`TVL         ${Number.isFinite(tvl) ? usd(tvl) : 'n/a'}`);
  lines.push(`24h volume  ${Number.isFinite(vol24) ? usd(vol24) : 'n/a'}`);
  lines.push(`24h fees    ${Number.isFinite(fees24) ? usd(fees24) : 'n/a'}`);
  lines.push(
    `vol/TVL     ${Number.isFinite(vol24) && tvl > 0 ? (vol24 / tvl).toFixed(3) : 'n/a'} ` +
      `(floor ${params.volTvlFloor})`,
  );
  lines.push(`fee (bps)   ${toNum(latestSnapshot.feeBps).toFixed(2)}`);
  lines.push('');

  lines.push('<b>Volatility (annualized)</b>');
  lines.push(`fast        ${pct(toNum(latestSnapshot.volFast), 1)}`);
  lines.push(`slow        ${pct(toNum(latestSnapshot.volSlow), 1)}`);
  lines.push('');

  const counts = new Map<string, number>();
  for (const d of decisions) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  lines.push('<b>Decisions (24h)</b>');
  lines.push(
    [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join('  ') || 'none',
  );
  const notable = decisions.filter((d) => d.kind !== 'HOLD');
  for (const d of notable.slice(-10)) {
    const reasons = Array.isArray(d.reasonsJson) ? (d.reasonsJson as string[]) : [];
    lines.push('');
    lines.push(
      `<b>${d.kind}</b> ${d.ts.toISOString()}${d.applied ? '' : ' <i>(not applied)</i>'}`,
    );
    for (const reason of reasons) lines.push(`• ${escapeHtml(reason)}`);
  }
  lines.push('');

  let verdictPass = false;
  if (opts.includeGoLive) {
    const verdict = await evaluateGoLive(prisma, params, now);
    verdictPass = verdict.pass;
    lines.push('<b>Go-live gate (advisory)</b>');
    for (const line of verdict.lines) lines.push(escapeHtml(line));
    lines.push(verdict.pass ? '<b>VERDICT: GATE CLEAR</b>' : '<b>VERDICT: KEEP SHADOWING</b>');
  }

  return { text: lines.join('\n'), verdictPass };
}
