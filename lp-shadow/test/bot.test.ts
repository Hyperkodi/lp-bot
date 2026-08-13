import { describe, expect, it } from 'vitest';
import type { PoolSummary, ReplayReport, WhyReport } from '../src/service/index.js';
import { chunkMessage, renderReplay, renderWhy } from '../src/bot/render.js';

const pool: PoolSummary = {
  managedPoolId: 'pool-1',
  label: 'SOL-USDC',
  poolAddress: '11111111111111111111111111111111',
  mode: 'SHADOW',
  role: 'PRIMARY',
  virtualNavUsd: 10_000,
  strategyVersion: 1,
  createdAt: '2026-08-13T00:00:00.000Z',
  daysOfData: 1,
};

describe('Telegram renderers', () => {
  it('escapes HTML in decision reasons', () => {
    const report: WhyReport = {
      pool,
      lastNonHold: null,
      latest: {
        kind: 'HOLD',
        ts: '2026-08-13T00:00:00.000Z',
        reasons: ['fee gate: 1 < 2 & waiting > threshold'],
        applied: false,
      },
      decisions24h: { HOLD: 1 },
    };

    const html = renderWhy(report);

    expect(html).toContain('fee gate: 1 &lt; 2 &amp; waiting &gt; threshold');
    expect(html).not.toContain('fee gate: 1 < 2');
  });

  it('renders the zero-snapshot replay reply verbatim', () => {
    const report: ReplayReport = {
      pool,
      fromTs: '2026-08-12T00:00:00.000Z',
      toTs: '2026-08-13T00:00:00.000Z',
      snapshots: 0,
      results: [],
    };

    expect(renderReplay(report)).toBe('No stored snapshots yet — the loop needs to run first.');
  });

  it('splits payloads over 4096 characters without losing line breaks', () => {
    const payload = 'decision trail line\n'.repeat(300);
    const chunks = chunkMessage(payload);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join('')).toBe(payload);
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith('\n'))).toBe(true);
  });
});
