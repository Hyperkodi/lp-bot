import { runVariant, type ReplayResult, type StoredSnapshot, type Variant } from '../replay/replay.js';
import type { Params } from '../types.js';
import { STRATEGY_PROFILES, paramsForProfile, type StrategyProfileSlug } from './profiles.js';

export type ProfileVariant = Variant & {
  profileSlug: StrategyProfileSlug;
  distributionShape: (typeof STRATEGY_PROFILES)[StrategyProfileSlug]['distributionShape'];
  defaultBinStepBps: number;
  launchGuardHours: number;
};

export function profileVariants(baseline: Params): ProfileVariant[] {
  return (Object.keys(STRATEGY_PROFILES) as StrategyProfileSlug[]).map((profileSlug) => {
    const profile = STRATEGY_PROFILES[profileSlug];
    return {
      name: profile.name,
      profileSlug,
      params: paramsForProfile(baseline, profileSlug),
      distributionShape: profile.distributionShape,
      defaultBinStepBps: profile.defaultBinStepBps,
      launchGuardHours: profile.launchGuardHours,
    };
  });
}

/**
 * Re-expresses a price path in the bin coordinates of a hypothetical pool.
 * Price, volume, fees, and liquidity observations are intentionally unchanged;
 * this isolates bin-step behavior but does not claim the hypothetical pool
 * would have attracted the same order flow.
 */
export function rebinSnapshots(stored: StoredSnapshot[], binStepBps: number): StoredSnapshot[] {
  if (!Number.isFinite(binStepBps) || binStepBps <= 0) {
    throw new Error('strategy lab bin step must be positive');
  }
  const first = stored[0];
  if (!first) return [];
  const anchorPrice = first.snapshot.activePrice;
  if (!(anchorPrice > 0)) throw new Error('strategy lab requires a positive anchor price');
  const anchorBin = first.snapshot.activeBinId;
  const logStep = Math.log1p(binStepBps / 10_000);

  return stored.map((row) => {
    if (!(row.snapshot.activePrice > 0)) {
      throw new Error('strategy lab cannot re-bin a non-positive price');
    }
    return {
      ...row,
      snapshot: {
        ...row.snapshot,
        activeBinId:
          anchorBin + Math.round(Math.log(row.snapshot.activePrice / anchorPrice) / logStep),
        binStepBps,
      },
    };
  });
}

export type StrategyScenario = {
  name: string;
  evidence: 'SYNTHETIC' | 'HISTORICAL';
  snapshots: StoredSnapshot[];
};

const SYNTHETIC_START_MS = Date.UTC(2026, 0, 1);
const SYNTHETIC_STEP_MS = 5 * 60_000;
const SYNTHETIC_STEPS = 3 * 24 * 12 + 1;

type SyntheticPath = 'quiet-market' | 'uptrend' | 'launch-drawdown' | 'volatile-chop';

function syntheticPrice(path: SyntheticPath, progress: number, index: number): number {
  if (path === 'quiet-market') return 100 * (1 + 0.004 * Math.sin(index / 16));
  if (path === 'uptrend') {
    return 100 * Math.exp(Math.log(2) * progress) * (1 + 0.012 * Math.sin(index / 9));
  }
  if (path === 'launch-drawdown') {
    if (progress < 0.2) return 100 * (1 + 0.08 * (progress / 0.2));
    return 108 * Math.exp(Math.log(0.28) * ((progress - 0.2) / 0.8));
  }
  return 100 * Math.exp(0.12 * Math.sin(progress * Math.PI * 12) + 0.04 * Math.sin(index / 3));
}

function syntheticScenario(name: SyntheticPath): StrategyScenario {
  const feeByPath: Record<SyntheticPath, number> = {
    'quiet-market': 18,
    uptrend: 35,
    'launch-drawdown': 45,
    'volatile-chop': 60,
  };
  const anchorPrice = syntheticPrice(name, 0, 0);
  const sourceBinStepBps = 25;
  const logStep = Math.log1p(sourceBinStepBps / 10_000);
  const snapshots: StoredSnapshot[] = Array.from({ length: SYNTHETIC_STEPS }, (_, index) => {
    const progress = index / (SYNTHETIC_STEPS - 1);
    const activePrice = syntheticPrice(name, progress, index);
    return {
      id: BigInt(index + 1),
      costInputs: {
        swapNotionalUsd: 5_000,
        swapOutValueUsd: 4_997,
        quotePriceImpactPct: 0.0006,
        priorityFeeMicroLamportsPerCu: 5_000,
        solPriceUsd: 150,
        newBinArrayRentLamports: 0,
      },
      snapshot: {
        ts: SYNTHETIC_START_MS + index * SYNTHETIC_STEP_MS,
        activeBinId: Math.round(Math.log(activePrice / anchorPrice) / logStep),
        activePrice,
        binStepBps: sourceBinStepBps,
        feeBps: 30,
        liqActiveBin: 250_000,
        liqNearby: [],
        poolTvlUsd: 1_000_000,
        poolVol24hUsd: 4_000_000,
        poolFees24hUsd: feeByPath[name] * 288,
        poolFeesIntervalUsd: feeByPath[name],
      },
    };
  });
  return { name, evidence: 'SYNTHETIC', snapshots };
}

export function syntheticStrategyScenarios(): StrategyScenario[] {
  return (['quiet-market', 'uptrend', 'launch-drawdown', 'volatile-chop'] as const).map(
    syntheticScenario,
  );
}

export type ProfileScenarioResult = {
  scenario: string;
  evidence: StrategyScenario['evidence'];
  profileSlug: StrategyProfileSlug;
  distributionShape: ProfileVariant['distributionShape'];
  binStepBps: number;
  replay: ReplayResult;
};

export function evaluateProfiles(
  baseline: Params,
  scenarios: StrategyScenario[],
): ProfileScenarioResult[] {
  const variants = profileVariants(baseline);
  return scenarios.flatMap((scenario) =>
    variants.map((variant) => ({
      scenario: scenario.name,
      evidence: scenario.evidence,
      profileSlug: variant.profileSlug,
      distributionShape: variant.distributionShape,
      binStepBps: variant.defaultBinStepBps,
      replay: runVariant(
        {
          ...variant,
          poolCreatedAtMs: scenario.snapshots[0]?.snapshot.ts,
        },
        rebinSnapshots(scenario.snapshots, variant.defaultBinStepBps),
      ),
    })),
  );
}
