import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { DLMM } from '../poller/dlmmSdk.js';

export const STANDARD_POOL_FUNCTION_TYPES = {
  0: 'LIMIT_ORDER',
  1: 'LIQUIDITY_MINING',
} as const;

export const STANDARD_POOL_COLLECT_FEE_MODES = {
  0: 'INPUT_ONLY',
  1: 'ONLY_Y',
} as const;

export type StandardPoolFunctionType =
  (typeof STANDARD_POOL_FUNCTION_TYPES)[keyof typeof STANDARD_POOL_FUNCTION_TYPES];
export type StandardPoolCollectFeeMode =
  (typeof STANDARD_POOL_COLLECT_FEE_MODES)[keyof typeof STANDARD_POOL_COLLECT_FEE_MODES];

export type VerifiedStandardPoolPreset = {
  address: string;
  binStepBps: number;
  baseFeeBps: string;
  baseFactor: number;
  baseFeePowerFactor: number;
  concreteFunctionType: StandardPoolFunctionType;
  collectFeeMode: StandardPoolCollectFeeMode;
  source: 'DEVNET_ON_CHAIN_PRESET_PARAMETER_2';
};

export type StandardPoolPresetRequirement = {
  binStepBps: number;
  baseFeeBps: number | string;
  concreteFunctionType: StandardPoolFunctionType;
  collectFeeMode: StandardPoolCollectFeeMode;
};

type RawPresetParameter2 = {
  publicKey: PublicKey;
  account: {
    binStep: number;
    baseFactor: number;
    baseFeePowerFactor: number;
    concreteFunctionType: number;
    collectFeeMode: number;
  };
};

function knownEnumValue<T extends string>(
  values: Record<number, T>,
  value: number,
  name: string,
): T {
  const result = values[value];
  if (result === undefined) throw new Error(`unknown ${name} value ${value} in Standard-pool preset`);
  return result;
}

export function normalizeStandardPoolPreset(raw: RawPresetParameter2): VerifiedStandardPoolPreset {
  const { account } = raw;
  const fee = DLMM.calculateFeeInfo(
    account.baseFactor,
    account.binStep,
    account.baseFeePowerFactor,
  );
  const baseFeeBps = new Decimal(fee.baseFeeRatePercentage.toString()).mul(100).toString();
  return {
    address: raw.publicKey.toBase58(),
    binStepBps: account.binStep,
    baseFeeBps,
    baseFactor: account.baseFactor,
    baseFeePowerFactor: account.baseFeePowerFactor,
    concreteFunctionType: knownEnumValue(
      STANDARD_POOL_FUNCTION_TYPES,
      account.concreteFunctionType,
      'concreteFunctionType',
    ),
    collectFeeMode: knownEnumValue(
      STANDARD_POOL_COLLECT_FEE_MODES,
      account.collectFeeMode,
      'collectFeeMode',
    ),
    source: 'DEVNET_ON_CHAIN_PRESET_PARAMETER_2',
  };
}

export function presetMatchesRequirement(
  preset: VerifiedStandardPoolPreset,
  requirement: StandardPoolPresetRequirement,
): boolean {
  return preset.binStepBps === requirement.binStepBps
    && new Decimal(preset.baseFeeBps).equals(new Decimal(requirement.baseFeeBps))
    && preset.concreteFunctionType === requirement.concreteFunctionType
    && preset.collectFeeMode === requirement.collectFeeMode;
}

export function findMatchingStandardPoolPresets(
  presets: readonly VerifiedStandardPoolPreset[],
  requirement: StandardPoolPresetRequirement,
): VerifiedStandardPoolPreset[] {
  return presets.filter((preset) => presetMatchesRequirement(preset, requirement));
}

/** Read-only discovery. No keypair, transaction, signing, or send path exists here. */
export async function discoverDevnetStandardPoolPresets(
  endpoint = 'https://api.devnet.solana.com',
): Promise<VerifiedStandardPoolPreset[]> {
  if (!endpoint.toLowerCase().includes('devnet')) {
    throw new Error('Standard-pool preset discovery is devnet-only');
  }
  const connection = new Connection(endpoint, 'confirmed');
  const result = await DLMM.getAllPresetParameters(connection, { cluster: 'devnet' });
  return result.presetParameter2
    .map((preset) => normalizeStandardPoolPreset(preset))
    .sort((left, right) => left.binStepBps - right.binStepBps
      || new Decimal(left.baseFeeBps).cmp(right.baseFeeBps)
      || left.address.localeCompare(right.address));
}

