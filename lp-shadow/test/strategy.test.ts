import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRawConfig, toParams } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import { BINS_PER_CLASSIC_POSITION } from '../src/poller/sdkConstants.js';
import {
  STRATEGY_PROFILES,
  applyLaunchGuard,
  paramsForProfile,
  publishBuiltInProfiles,
  type StrategyProfileSlug,
} from '../src/strategy/index.js';
import type { Decision } from '../src/types.js';

const baseline = toParams(loadRawConfig('config/default.toml'), BINS_PER_CLASSIC_POSITION);
const hasDatabase = Boolean(process.env.DATABASE_URL);
const builtInSlugs = ['fee-maximizer', 'market-depth', 'treasury-defensive'];

describe('founder strategy profiles', () => {
  it('ships the three approved profiles with honest trade-off copy', () => {
    expect(Object.keys(STRATEGY_PROFILES)).toEqual([
      'fee-maximizer',
      'market-depth',
      'treasury-defensive',
    ]);
    expect(STRATEGY_PROFILES['fee-maximizer'].tradeoff).toMatch(/impermanent loss/i);
    expect(STRATEGY_PROFILES['market-depth'].tradeoff).toMatch(/fewer rebalances/i);
    expect(STRATEGY_PROFILES['treasury-defensive'].tradeoff).toMatch(/lowest fee revenue/i);
  });

  it.each<StrategyProfileSlug>(['fee-maximizer', 'market-depth', 'treasury-defensive'])(
    'overlays only engine strategy parameters for %s',
    (slug) => {
      const result = paramsForProfile(baseline, slug);
      const profile = STRATEGY_PROFILES[slug];

      expect(result).toMatchObject(profile.params);
      expect(result.poolAddress).toBe(baseline.poolAddress);
      expect(result.virtualNavUsd).toBe(baseline.virtualNavUsd);
      expect(result.snapshotIntervalSec).toBe(baseline.snapshotIntervalSec);
      expect(baseline.widthK).toBe(1.5);
    },
  );

  it('maps profile intent to Curve, Spot, and BidAsk DLMM shapes', () => {
    expect(STRATEGY_PROFILES['fee-maximizer'].distributionShape).toBe('CURVE');
    expect(STRATEGY_PROFILES['market-depth'].distributionShape).toBe('SPOT');
    expect(STRATEGY_PROFILES['treasury-defensive'].distributionShape).toBe('BID_ASK');
  });
});

describe.skipIf(!hasDatabase)('strategy profile ledger', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');

  async function truncateTouchedTables() {
    await prisma.strategyProfileVersion.deleteMany({
      where: { profile: { slug: { in: builtInSlugs } } },
    });
    await prisma.strategyProfile.deleteMany({ where: { slug: { in: builtInSlugs } } });
  }

  beforeAll(truncateTouchedTables);
  afterAll(async () => {
    await truncateTouchedTables();
    await disconnectPrisma();
  });

  it('publishes one immutable initial version per built-in profile idempotently', async () => {
    const first = await publishBuiltInProfiles(prisma, baseline);
    const second = await publishBuiltInProfiles(prisma, baseline);

    expect(first.map((row) => row.slug)).toEqual(builtInSlugs);
    expect(first.every((row) => row.version === 1)).toBe(true);
    expect(second).toEqual(first);
    expect(
      await prisma.strategyProfileVersion.count({
        where: { profile: { slug: { in: builtInSlugs } } },
      }),
    ).toBe(3);
  });
});

describe('launch guard', () => {
  const rebalance: Decision = {
    kind: 'REBALANCE',
    newLowerBin: -35,
    newUpperBin: 34,
    costEst: { slippageUsd: 1, priorityFeeUsd: 1, txFeesUsd: 1, rentDeltaUsd: 1, totalUsd: 4 },
    reasons: ['out of range', 'settled', 'cost covered'],
  };

  it('suppresses a rebalance before the guard expires and preserves its trail', () => {
    const result = applyLaunchGuard(rebalance, {
      poolCreatedAtMs: 1_000,
      nowMs: 1_000 + 24 * 60 * 60 * 1_000 - 1,
      launchGuardHours: 24,
    });

    expect(result.active).toBe(true);
    expect(result.decision.kind).toBe('HOLD');
    expect(result.suppressedDecision).toEqual(rebalance);
    expect(result.decision.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/launch guard active/i),
        expect.stringContaining('out of range'),
        expect.stringContaining('cost covered'),
      ]),
    );
  });

  it('allows the rebalance at the exact expiry boundary', () => {
    const expiresAt = 1_000 + 24 * 60 * 60 * 1_000;
    const result = applyLaunchGuard(rebalance, {
      poolCreatedAtMs: 1_000,
      nowMs: expiresAt,
      launchGuardHours: 24,
    });

    expect(result.active).toBe(false);
    expect(result.decision).toBe(rebalance);
    expect(result.suppressedDecision).toBeNull();
  });

  it.each<Decision>([
    { kind: 'HOLD', reasons: ['already holding'] },
    { kind: 'COMPOUND', feesQuote: 2, reasons: ['fees ready'] },
    {
      kind: 'EXIT',
      costEst: { slippageUsd: 0, priorityFeeUsd: 0, txFeesUsd: 1, rentDeltaUsd: 0, totalUsd: 1 },
      reasons: ['founder instructed exit'],
    },
  ])('does not suppress $kind during the launch guard', (decision) => {
    const result = applyLaunchGuard(decision, {
      poolCreatedAtMs: 0,
      nowMs: 1,
      launchGuardHours: 24,
    });
    expect(result.decision).toBe(decision);
    expect(result.suppressedDecision).toBeNull();
  });
});
