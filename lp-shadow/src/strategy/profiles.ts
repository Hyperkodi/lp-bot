import type { Params } from '../types.js';

export type StrategyProfileSlug = 'fee-maximizer' | 'market-depth' | 'treasury-defensive';
export type DistributionShape = 'SPOT' | 'CURVE' | 'BID_ASK';

type ProfileParams = Pick<
  Params,
  'widthK' | 'oorDwellMin' | 'edgeOvershootPct' | 'settleMin' | 'costCoverageMultiple'
>;

export type StrategyProfileDefinition = {
  slug: StrategyProfileSlug;
  name: string;
  description: string;
  tradeoff: string;
  params: Readonly<ProfileParams>;
  distributionShape: DistributionShape;
  defaultBinStepBps: number;
  launchGuardHours: number;
};

const LAUNCH_GUARD_HOURS = 24;

// TODO(profile-replay): all numeric profile values, including the shared 24h
// launch guard, are initial configuration. Tune them only from replay and live
// shadow evidence; do not let a copy change silently rewrite old versions.
export const STRATEGY_PROFILES: Readonly<
  Record<StrategyProfileSlug, Readonly<StrategyProfileDefinition>>
> = Object.freeze({
  'fee-maximizer': Object.freeze({
    slug: 'fee-maximizer',
    name: 'Fee Maximizer',
    description: 'A narrow Curve distribution that follows the active bin aggressively.',
    tradeoff:
      'Highest fee capture per dollar; most exposed to impermanent loss and highest rebalance costs.',
    params: Object.freeze({
      widthK: 0.8,
      oorDwellMin: 15,
      edgeOvershootPct: 0.5,
      settleMin: 10,
      costCoverageMultiple: 2,
    }),
    distributionShape: 'CURVE',
    defaultBinStepBps: 10,
    launchGuardHours: LAUNCH_GUARD_HOURS,
  }),
  'market-depth': Object.freeze({
    slug: 'market-depth',
    name: 'Market Depth',
    description: 'A wide, even Spot distribution built for lower slippage across the range.',
    tradeoff: 'Flatter fee capture, fewer rebalances, and a better experience for buyers.',
    params: Object.freeze({
      widthK: 2.5,
      oorDwellMin: 60,
      edgeOvershootPct: 2,
      settleMin: 20,
      costCoverageMultiple: 4,
    }),
    distributionShape: 'SPOT',
    defaultBinStepBps: 25,
    launchGuardHours: LAUNCH_GUARD_HOURS,
  }),
  'treasury-defensive': Object.freeze({
    slug: 'treasury-defensive',
    name: 'Treasury Defensive',
    description: 'A wide BidAsk distribution with conservative re-entry during volatile launches.',
    tradeoff:
      'Lowest fee revenue; prioritizes converting less of the treasury into the falling side.',
    params: Object.freeze({
      widthK: 3,
      oorDwellMin: 120,
      edgeOvershootPct: 3,
      settleMin: 60,
      costCoverageMultiple: 5,
    }),
    distributionShape: 'BID_ASK',
    defaultBinStepBps: 50,
    launchGuardHours: LAUNCH_GUARD_HOURS,
  }),
});

export function paramsForProfile(baseline: Params, slug: StrategyProfileSlug): Params {
  return { ...baseline, ...STRATEGY_PROFILES[slug].params };
}

