import type { StoredSnapshot } from '../replay/replay.js';
import type { OhlcvCandle, PoolStats } from '../poller/meteoraApi.js';
import type { StrategyScenario } from './lab.js';

export type HistoricalProxyAssumptions = {
  currentTvlUsd: number;
  baseFeePct: number;
  virtualRangeBins: number;
  swapFallbackImpactBps: number;
};

export type HistoricalScenario = StrategyScenario & {
  evidence: 'HISTORICAL';
  limitations: string[];
};

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
    !(assumptions.currentTvlUsd > 0) ||
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
        liqActiveBin: assumptions.currentTvlUsd / assumptions.virtualRangeBins,
        liqNearby: [],
        poolTvlUsd: assumptions.currentTvlUsd,
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
      'Current TVL is held constant because historical TVL and per-bin liquidity are unavailable.',
      'Fees use candle volume multiplied by the pool base fee; dynamic fees are unavailable.',
      'Rebalance swaps use the configured impact fallback; historical Jupiter routes are unavailable.',
    ],
  };
}
