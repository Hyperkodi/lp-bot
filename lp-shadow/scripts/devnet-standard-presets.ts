import {
  discoverDevnetStandardPoolPresets,
  findMatchingStandardPoolPresets,
  type StandardPoolPresetRequirement,
} from '../src/execution/standardPoolPreset.js';

const endpoint = process.argv[2] ?? 'https://api.devnet.solana.com';
const requirement: StandardPoolPresetRequirement = {
  binStepBps: 50,
  baseFeeBps: 30,
  concreteFunctionType: 'LIQUIDITY_MINING',
  collectFeeMode: 'INPUT_ONLY',
};

const presets = await discoverDevnetStandardPoolPresets(endpoint);
const matches = findMatchingStandardPoolPresets(presets, requirement);

console.log(JSON.stringify({
  mode: 'READ_ONLY_DEVNET_DISCOVERY',
  requirement,
  presetParameter2Count: presets.length,
  matchingPresetCount: matches.length,
  matches,
  availablePresets: presets,
  blocker: matches.length === 0
    ? 'No public devnet Standard-pool preset matches the reviewed launch economics and mode.'
    : null,
}, null, 2));

