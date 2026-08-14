import type { StoredSnapshot } from '../replay/replay.js';
import type { OhlcvCandle, PoolStats } from '../poller/meteoraApi.js';
import type { StrategyScenario } from './lab.js';

export type HistoricalProxyAssumptions = {
  modeledTvlUsd: number;
  baseFeePct: number;
  virtualRangeBins: number;
  swapFallbackImpactBps: number;
};

export type HistoricalScenario = StrategyScenario & {
  evidence: 'HISTORICAL';
  limitations: string[];
};

/**
 * Meteora omits some inactive intervals. After the first observed candle,
 * represent an omitted interval as no trade: unchanged close and zero volume.
 */
export function fillOhlcvGaps(
  candles: OhlcvCandle[],
  startTimeSec: number,
  endTimeSec: number,
  stepSec: number,
): OhlcvCandle[] {
  if (
    candles.length === 0 ||
    !Number.isInteger(startTimeSec) ||
    !Number.isInteger(endTimeSec) ||
    !Number.isInteger(stepSec) ||
    stepSec <= 0 ||
    endTimeSec < startTimeSec
  ) {
    throw new Error('OHLCV gap fill requires candles and a valid bounded interval');
  }
  const observed = new Map(candles.map((candle) => [candle.timestamp, candle]));
  let previous: OhlcvCandle | undefined;
  const filled: OhlcvCandle[] = [];
  for (let timestamp = startTimeSec; timestamp <= endTimeSec; timestamp += stepSec) {
    const current = observed.get(timestamp);
    if (current) {
      previous = current;
      filled.push(current);
    } else if (previous) {
      filled.push({
        timestamp,
        open: previous.close,
        high: previous.close,
        low: previous.close,
        close: previous.close,
        volume: 0,
      });
    }
  }
  if (filled.length === 0) throw new Error('OHLCV gap fill found no candle inside the interval');
  return filled;
}

export function historicalScenarioFromOhlcv(
  name: string,
  candles: OhlcvCandle[],
  metadata: Pick<PoolStats, 'binStepBps'>,
  assumptions: HistoricalProxyAssumptions,
): HistoricalScenario {
  if (candles.length < 21) throw new Error('historical replay requires at least 21 candles');
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const firstPrice = sorted[0]!.close;
  const binStepBps = metadata.binStepBps;
  if (!(firstPrice > 0) || !(binStepBps && binStepBps > 0)) {
    throw new Error('historical replay requires positive price and bin step');
  }
  if (
    !(assumptions.modeledTvlUsd > 0) ||
    !(assumptions.virtualRangeBins > 0) ||
    assumptions.baseFeePct < 0
  ) {
    throw new Error('historical replay proxy assumptions are invalid');
  }
  const logStep = Math.log1p(binStepBps / 10_000);
  const trailingVolumes: { ts: number; volume: number }[] = [];
  let rolling24hVolume = 0;

  const snapshots: StoredSnapshot[] = sorted.map((candle, index) => {
    const ts = candle.timestamp * 1_000;
    trailingVolumes.push({ ts, volume: candle.volume });
    rolling24hVolume += candle.volume;
    while (trailingVolumes[0] && trailingVolumes[0].ts < ts - 24 * 60 * 60 * 1_000) {
      rolling24hVolume -= trailingVolumes.shift()!.volume;
    }
    const activePrice = (candle.close / firstPrice) * 100;
    return {
      id: BigInt(index + 1),
      costInputs: {
        swapNotionalUsd: 5_000,
        swapOutValueUsd: null,
        quotePriceImpactPct: assumptions.swapFallbackImpactBps / 10_000,
        priorityFeeMicroLamportsPerCu: 0,
        solPriceUsd: 0,
        newBinArrayRentLamports: 0,
      },
      snapshot: {
        ts,
        activeBinId: Math.round(Math.log(candle.close / firstPrice) / logStep),
        activePrice,
        binStepBps,
        feeBps: assumptions.baseFeePct * 100,
        liqActiveBin: assumptions.modeledTvlUsd / assumptions.virtualRangeBins,
        liqNearby: [],
        poolTvlUsd: assumptions.modeledTvlUsd,
        poolVol24hUsd: rolling24hVolume,
        poolFees24hUsd: rolling24hVolume * (assumptions.baseFeePct / 100),
        poolFeesIntervalUsd: candle.volume * (assumptions.baseFeePct / 100),
      },
    };
  });

  return {
    name,
    evidence: 'HISTORICAL',
    snapshots,
    limitations: [
      'Meteora close prices and volumes are historical observations.',
      'Intracandle high/low paths are not replayed.',
      'A fixed modeled TVL is used because historical TVL and per-bin liquidity are unavailable.',
      'Fees use candle volume multiplied by the pool base fee; dynamic fees are unavailable.',
      'Rebalance swaps use the configured impact fallback; historical Jupiter routes are unavailable.',
    ],
  };
}
