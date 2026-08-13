import type {
  PoolPreview,
  PoolSummary,
  ReplayReport,
  StrategyInfo,
  VerdictReport,
  WhyReport,
} from '../service/index.js';

export const TELEGRAM_MESSAGE_LIMIT = 4096;

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Headroom reserved per chunk so re-balancing HTML tags across chunk
 * boundaries (closing at the end, reopening at the start) can never push a
 * chunk over the Telegram limit.
 */
const BALANCE_HEADROOM = 64;

/** The formatting tags this bot emits. Escaped user content never matches. */
const TAG_RE = /<\/?(b|i|pre|code)>/g;

/** Tags still open after scanning `html`, in opening order. */
function openTagsAfter(html: string): string[] {
  const stack: string[] = [];
  for (const match of html.matchAll(TAG_RE)) {
    const tag = match[1]!;
    if (match[0].startsWith('</')) {
      const at = stack.lastIndexOf(tag);
      if (at >= 0) stack.splice(at, 1);
    } else {
      stack.push(tag);
    }
  }
  return stack;
}

/**
 * Telegram parses each message's HTML independently, so a <pre> table (or any
 * tag pair) spanning a chunk boundary would 400 both chunks. Close whatever is
 * open at each boundary and reopen it at the start of the next chunk.
 */
function balanceHtml(chunks: string[]): string[] {
  const out: string[] = [];
  let carry: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const prefixed = carry.map((tag) => `<${tag}>`).join('') + chunk;
    if (index === chunks.length - 1) {
      out.push(prefixed);
      break;
    }
    carry = openTagsAfter(prefixed);
    out.push(prefixed + [...carry].reverse().map((tag) => `</${tag}>`).join(''));
  }
  return out;
}

/**
 * Split without discarding any content. Newline-terminated pieces are kept
 * together whenever possible; a single overlong line is split as a fallback
 * (which can cut through a tag literal — the tables this bot emits are
 * multi-line, so in practice boundaries land between lines).
 */
export function chunkMessage(message: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit <= BALANCE_HEADROOM) {
    throw new RangeError(`Message limit must be an integer above ${BALANCE_HEADROOM}.`);
  }
  if (message.length <= limit) return [message];
  const budget = limit - BALANCE_HEADROOM;

  const pieces = message.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const piece of pieces) {
    if (piece.length > budget) {
      flush();
      for (let offset = 0; offset < piece.length; offset += budget) {
        const part = piece.slice(offset, offset + budget);
        if (part.length === budget) chunks.push(part);
        else current = part;
      }
      continue;
    }

    if (current.length + piece.length > budget) flush();
    current += piece;
  }

  flush();
  return balanceHtml(chunks);
}

function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

function formatOptionalMoney(value: number | null): string {
  return value === null ? 'Unavailable' : formatMoney(value);
}

function formatOptionalNumber(value: number | null, suffix = ''): string {
  return value === null ? 'Unavailable' : `${numberFormatter.format(value)}${suffix}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function plainTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const formatRow = (row: string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join('  ').trimEnd();
  return [formatRow(headers), formatRow(widths.map((width) => '─'.repeat(width))), ...rows.map(formatRow)].join(
    '\n',
  );
}

export function renderPoolPreview(preview: PoolPreview): string {
  const name = preview.name ?? 'Unnamed pool';
  return [
    `<b>${escapeHtml(name)}</b>`,
    `Address: ${escapeHtml(preview.poolAddress)}`,
    `TVL: ${escapeHtml(formatOptionalMoney(preview.tvlUsd))}`,
    `24h volume: ${escapeHtml(formatOptionalMoney(preview.vol24hUsd))}`,
    `24h fees: ${escapeHtml(formatOptionalMoney(preview.fees24hUsd))}`,
    `Bin step: ${escapeHtml(formatOptionalNumber(preview.binStepBps, ' bps'))}`,
    '',
    'How much would you actually deploy, in USD?',
  ].join('\n');
}

export function renderAddConfirmation(preview: PoolPreview, virtualNavUsd: number): string {
  return [
    '<b>Confirm shadow pool</b>',
    `Pool: ${escapeHtml(preview.name ?? preview.poolAddress.slice(0, 8))}`,
    `Size: ${escapeHtml(formatMoney(virtualNavUsd))}`,
  ].join('\n');
}

export function renderPools(pools: PoolSummary[]): string {
  if (pools.length === 0) return 'No pools yet — add one with /add.';

  const rows = pools.map((pool) => [
    pool.label,
    pool.mode,
    formatMoney(pool.virtualNavUsd),
    numberFormatter.format(pool.daysOfData),
  ]);
  return `<b>Pools</b>\n<pre>${escapeHtml(plainTable(['Label', 'Mode', 'Size', 'Days'], rows))}</pre>`;
}

export function renderWhy(report: WhyReport): string {
  const lines = [`<b>Why — ${escapeHtml(report.pool.label)}</b>`, ''];

  if (report.lastNonHold) {
    lines.push(
      `<b>${escapeHtml(report.lastNonHold.kind)}</b> — ${escapeHtml(formatTimestamp(report.lastNonHold.ts))}`,
      ...report.lastNonHold.reasons.map((reason) => `• ${escapeHtml(reason)}`),
      '',
      `Since then: HOLD ×${escapeHtml(String(report.decisions24h.HOLD ?? 0))}`,
    );
    return lines.join('\n');
  }

  lines.push('No non-HOLD decisions yet. The latest tick decided:');
  if (report.latest) {
    lines.push(
      `<b>${escapeHtml(report.latest.kind)}</b> — ${escapeHtml(formatTimestamp(report.latest.ts))}`,
      ...report.latest.reasons.map((reason) => `• ${escapeHtml(reason)}`),
    );
  } else {
    lines.push('No decisions have been recorded yet.');
  }
  return lines.join('\n');
}

const strategyGroups: Array<{
  name: string;
  explanation: string;
  keys: string[];
}> = [
  {
    name: 'rebalance',
    explanation:
      're-centre only when out of range, past the edge, settled, and the fees would repay the cost',
    keys: [
      'oorDwellMin',
      'edgeOvershootPct',
      'settleBandPct',
      'settleMin',
      'costCoverageMultiple',
      'inRangeShareEstimate',
    ],
  },
  {
    name: 'compound',
    explanation: 'fold pending fees back in once they clear the minimum',
    keys: ['minFeesUsd', 'minFeesPctNav'],
  },
  {
    name: 'exit',
    explanation: "leave when the pool's volume/TVL stays under the floor too long",
    keys: ['volTvlFloor', 'volTvlDwellHours'],
  },
  {
    name: 'golive',
    explanation: 'the advisory gate: enough days, a regime change, and beating HODL',
    keys: ['goLiveMinShadowDays', 'goLiveRegimeChangeRatio'],
  },
];

function formatParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'not set';
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

export function renderStrategy(strategy: StrategyInfo): string {
  const lines = [
    `<b>Strategy v${escapeHtml(String(strategy.version))}</b>`,
    escapeHtml(strategy.note),
    `Published: ${escapeHtml(formatTimestamp(strategy.createdAt))}`,
  ];

  for (const group of strategyGroups) {
    const params = group.keys.map((key) => `${key}: ${formatParam(strategy.params[key])}`).join('\n');
    lines.push(
      '',
      `<b>${escapeHtml(group.name)}</b> — ${escapeHtml(group.explanation)}`,
      `<pre>${escapeHtml(params)}</pre>`,
    );
  }

  return lines.join('\n');
}

export function renderReplay(report: ReplayReport): string {
  if (report.snapshots === 0) {
    return 'No stored snapshots yet — the loop needs to run first.';
  }

  const rows = report.results.map((result) => [
    result.variant,
    `${result.netVsHodlUsd >= 0 ? '+' : ''}${formatMoney(result.netVsHodlUsd)}`,
    formatMoney(result.totalFeesUsd),
    formatMoney(result.totalCostsUsd),
    String(result.rebalances),
    `${numberFormatter.format(result.timeInRange * 100)}%`,
  ]);
  const table = plainTable(['Variant', 'vs HODL', 'Fees', 'Costs', 'Rebal', 'In range'], rows);

  return [
    `<b>Replay — ${escapeHtml(report.pool.label)}</b>`,
    `${escapeHtml(formatTimestamp(report.fromTs))} to ${escapeHtml(formatTimestamp(report.toTs))}`,
    `Snapshots: ${escapeHtml(String(report.snapshots))}`,
    `<pre>${escapeHtml(table)}</pre>`,
  ].join('\n');
}

export function renderVerdict(report: VerdictReport): string {
  const result = report.pass
    ? 'GATE CLEAR — worth discussing next steps.'
    : 'KEEP SHADOWING.';
  return [
    `<b>Verdict — ${escapeHtml(report.pool.label)}</b>`,
    '',
    ...report.lines.map(escapeHtml),
    '',
    `<b>${escapeHtml(result)}</b>`,
  ].join('\n');
}
