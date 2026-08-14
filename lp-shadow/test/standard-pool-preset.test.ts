import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  findMatchingStandardPoolPresets,
  normalizeStandardPoolPreset,
  presetMatchesRequirement,
} from '../src/execution/standardPoolPreset.js';

const address = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));

describe('Standard-pool preset verification', () => {
  it('derives the base fee with the SDK base-fee power factor', () => {
    const preset = normalizeStandardPoolPreset({
      publicKey: address(1),
      account: {
        binStep: 50,
        baseFactor: 60,
        baseFeePowerFactor: 0,
        concreteFunctionType: 1,
        collectFeeMode: 0,
      },
    });

    expect(preset).toMatchObject({
      address: address(1).toBase58(),
      binStepBps: 50,
      baseFeeBps: '0.3',
      concreteFunctionType: 'LIQUIDITY_MINING',
      collectFeeMode: 'INPUT_ONLY',
      source: 'DEVNET_ON_CHAIN_PRESET_PARAMETER_2',
    });
  });

  it('requires an exact fee, bin step, function type, and fee mode match', () => {
    const preset = {
      address: address(2).toBase58(),
      binStepBps: 50,
      baseFeeBps: '30',
      baseFactor: 6_000,
      baseFeePowerFactor: 0,
      concreteFunctionType: 'LIQUIDITY_MINING' as const,
      collectFeeMode: 'INPUT_ONLY' as const,
      source: 'DEVNET_ON_CHAIN_PRESET_PARAMETER_2' as const,
    };
    const requirement = {
      binStepBps: 50,
      baseFeeBps: 30,
      concreteFunctionType: 'LIQUIDITY_MINING' as const,
      collectFeeMode: 'INPUT_ONLY' as const,
    };

    expect(presetMatchesRequirement(preset, requirement)).toBe(true);
    expect(findMatchingStandardPoolPresets([preset], requirement)).toEqual([preset]);
    expect(presetMatchesRequirement(preset, { ...requirement, binStepBps: 10 })).toBe(false);
    expect(presetMatchesRequirement(preset, { ...requirement, baseFeeBps: 10 })).toBe(false);
    expect(presetMatchesRequirement(preset, {
      ...requirement,
      concreteFunctionType: 'LIMIT_ORDER',
    })).toBe(false);
    expect(presetMatchesRequirement(preset, { ...requirement, collectFeeMode: 'ONLY_Y' })).toBe(false);
  });

  it('fails closed for a future on-chain enum value', () => {
    expect(() => normalizeStandardPoolPreset({
      publicKey: address(3),
      account: {
        binStep: 10,
        baseFactor: 10_000,
        baseFeePowerFactor: 0,
        concreteFunctionType: 7,
        collectFeeMode: 0,
      },
    })).toThrow(/unknown concreteFunctionType/i);
  });
});
