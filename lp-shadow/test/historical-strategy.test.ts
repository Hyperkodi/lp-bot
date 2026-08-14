import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../src/poller/http.js', () => ({ fetchJson: (...args: unknown[]) => fetchJson(...args) }));

const { fetchPoolOhlcv, fetchPoolOhlcvRange, fetchPoolStats } = await import('../src/poller/meteoraApi.js');
const { historicalScenarioFromOhlcv } = await import('../src/strategy/historical.js');

afterEach(() => fetchJson.mockReset());

function candle(timestamp: number, close = 1, volume = 100) {
  return { timestamp, open: close, high: close, low: close, close, volume };
}

describe('Meteora historical data boundary', () => {
  it('maps current pool metadata and the renamed cumulative fees counter', async () => {
    fetchJson.mockResolvedValueOnce({
      address: 'pool',
      created_at: 1_700_000_000_000,
      cumulative_metrics: { fees: 123 },
      pool_config: { bin_step: 50, base_fee_pct: 0.3 },
      token_x: { address: 'base', symbol: 'BASE', decimals: 6 },
      token_y: { address: 'quote', symbol: 'SOL', decimals: 9 },
    });
    await expect(fetchPoolStats('pool')).resolves.toMatchObject({
      createdAtMs: 1_700_000_000_000,
      cumulativeTradeFeeUsd: 123,
      binStepBps: 50,
      baseFeePct: 0.3,
      baseMint: 'base',
      quoteMint: 'quote',
    });
  });

  it('sorts valid candles and rejects malformed market data', async () => {
    fetchJson.mockResolvedValueOnce({ data: [candle(600), candle(300)] });
    await expect(fetchPoolOhlcv('pool', '5m', 300, 600)).resolves.toEqual([
      candle(300),
      candle(600),
    ]);

    fetchJson.mockResolvedValueOnce({ data: [candle(300, -1)] });
    await expect(fetchPoolOhlcv('pool', '5m', 300, 600)).rejects.toThrow(/unusable candle/i);
  });

  it('chunks long ranges below the API candle cap and removes boundary duplicates', async () => {
    fetchJson
      .mockResolvedValueOnce({ data: [candle(0), candle(29_400)] })
      .mockResolvedValueOnce({ data: [candle(29_700), candle(30_000)] });
    const rows = await fetchPoolOhlcvRange('pool', '5m', 0, 30_000);

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.timestamp)).toEqual([0, 29_400, 29_700, 30_000]);
  });
});

describe('historical replay conversion', () => {
  it('preserves historical returns and volume while labeling unavailable inputs as proxies', () => {
    const candles = Array.from({ length: 21 }, (_, index) =>
      candle(index * 300, 1 + index / 100, 100 + index),
    );
    const scenario = historicalScenarioFromOhlcv(
      'launch-a',
      candles,
      { binStepBps: 50 },
      {
        currentTvlUsd: 69_000,
        baseFeePct: 0.3,
        virtualRangeBins: 69,
        swapFallbackImpactBps: 50,
      },
    );

    expect(scenario.evidence).toBe('HISTORICAL');
    expect(scenario.snapshots[0]!.snapshot.activePrice).toBe(100);
    expect(scenario.snapshots.at(-1)!.snapshot.activePrice).toBeCloseTo(120, 8);
    expect(scenario.snapshots[0]!.snapshot.liqActiveBin).toBe(1_000);
    expect(scenario.snapshots[0]!.snapshot.poolFeesIntervalUsd).toBeCloseTo(0.3, 8);
    expect(scenario.limitations).toEqual(expect.arrayContaining([
      expect.stringMatching(/current TVL/i),
      expect.stringMatching(/historical Jupiter/i),
    ]));
  });
});
