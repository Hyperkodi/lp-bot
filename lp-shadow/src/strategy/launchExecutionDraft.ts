import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import {
  deriveCustomizablePoolAddress,
  deriveMeteoraPoolProgramAccounts,
  deriveMeteoraPositionAddress,
  deriveStandardPoolAddress,
} from '../execution/meteoraDlmm.js';
import type { ExecutionRequest } from '../execution/types.js';
import { PERMANENT_INITIAL_POSITION_ROLE } from '../execution/initialLiquidityPolicy.js';
import type { InitialLiquidityLaunchPlan } from './launchPlanner.js';

export type LaunchExecutionDraftInput = {
  plan: InitialLiquidityLaunchPlan;
  projectWalletId: string;
  projectWalletAddress: string;
  founderWithdrawalAddress: string;
  feeTreasuryAddress: string;
  projectTokenMint: string;
  projectTokenProgramId?: string;
  projectTokenAmount: string;
  solAmount: string;
  walletSolAmount: string;
  tokenDecimals: number;
  idempotencyPrefix: string;
  poolCreation:
    | { mode: 'DEVNET_CUSTOMIZABLE_PROXY' }
    | { mode: 'STANDARD'; presetParameter: string };
};

export type LaunchExecutionDraft = {
  status: 'UNSIGNED_PREVIEW';
  cluster: 'devnet';
  poolType: 'DEVNET_CUSTOMIZABLE_PROXY' | 'STANDARD';
  matchesRequiredPoolType: boolean;
  orientation: {
    tokenX: 'PROJECT_TOKEN';
    tokenY: 'WRAPPED_SOL';
    priceUnit: 'SOL_PER_PROJECT_TOKEN';
  };
  poolAddress: string;
  positionAddress: string;
  atomicAmounts: {
    tokenX: string;
    tokenY: string;
    walletSol: string;
    gasReserve: string;
  };
  walletCoversKnownMinimum: boolean;
  exactNetworkCostRequiresPreflight: true;
  automaticInitialPositionManagement: false;
  requests: readonly [ExecutionRequest, ExecutionRequest];
};

function publicKey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a base58 public key`);
  }
}

export function toAtomicAmount(value: string, decimals: number, name: string): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`${name} decimals must be an integer from 0 to 18`);
  }
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new Error(`${name} must be a decimal amount`);
  }
  if (!amount.isFinite() || amount.isNegative()) {
    throw new Error(`${name} must be a finite non-negative amount`);
  }
  const atomic = amount.mul(new Decimal(10).pow(decimals));
  if (!atomic.isInteger()) throw new Error(`${name} has more than ${decimals} decimal places`);
  return BigInt(atomic.toFixed(0));
}

function assertSameAmount(value: string, planned: number, name: string): void {
  if (!new Decimal(value).equals(new Decimal(planned.toString()))) {
    throw new Error(`${name} does not match the reviewed launch plan`);
  }
}

/**
 * Converts a reviewed launch plan into deterministic devnet execution
 * requests. This function builds no transaction and has no signer or send path.
 */
export function draftLaunchExecution(input: LaunchExecutionDraftInput): LaunchExecutionDraft {
  if (!input.projectWalletId.trim()) throw new Error('projectWalletId is required');
  if (!input.idempotencyPrefix.trim()) throw new Error('idempotencyPrefix is required');
  assertSameAmount(input.projectTokenAmount, input.plan.deposit.tokenAmount, 'project token amount');
  assertSameAmount(input.solAmount, input.plan.deposit.positionSolAmount, 'SOL amount');

  const projectWallet = publicKey(input.projectWalletAddress, 'project wallet');
  const founderWithdrawal = publicKey(input.founderWithdrawalAddress, 'founder withdrawal address');
  const feeTreasury = publicKey(input.feeTreasuryAddress, 'fee treasury address');
  const projectToken = publicKey(input.projectTokenMint, 'project token mint');
  const projectTokenProgram = input.projectTokenProgramId
    ? publicKey(input.projectTokenProgramId, 'project token program')
    : TOKEN_PROGRAM_ID;
  const tokenXAmount = toAtomicAmount(input.projectTokenAmount, input.tokenDecimals, 'project token amount');
  const tokenYAmount = toAtomicAmount(input.solAmount, 9, 'SOL amount');
  const walletSolLamports = toAtomicAmount(input.walletSolAmount, 9, 'wallet SOL amount');
  const gasReserveLamports = toAtomicAmount(
    input.plan.deposit.gasReserveSol.toString(),
    9,
    'gas reserve',
  );
  const knownMinimumLamports = toAtomicAmount(
    input.plan.creationCost.minimumWalletSolWithKnownAccountRent.toString(),
    9,
    'known wallet minimum',
  );

  // The reviewed price is SOL per project token, so the mint roles are fixed.
  // Swapping these roles would invert every active-bin and range calculation.
  const presetParameter = input.poolCreation.mode === 'STANDARD'
    ? publicKey(input.poolCreation.presetParameter, 'standard pool preset parameter')
    : null;
  const poolAddress = presetParameter
    ? deriveStandardPoolAddress(presetParameter, projectToken, NATIVE_MINT)
    : deriveCustomizablePoolAddress(projectToken, NATIVE_MINT);
  const positionAddress = deriveMeteoraPositionAddress(
    poolAddress,
    projectWallet,
    new BN(input.plan.positionAccount.lowerBinId),
    new BN(input.plan.positionAccount.width),
  );
  const projectTokenAccount = getAssociatedTokenAddressSync(
    projectToken,
    projectWallet,
    true,
    projectTokenProgram,
  );
  const wrappedSolAccount = getAssociatedTokenAddressSync(NATIVE_MINT, projectWallet, true);
  const poolProgramAccounts = deriveMeteoraPoolProgramAccounts({
    tokenXMint: projectToken,
    tokenYMint: NATIVE_MINT,
    poolAddress,
    lowerBinId: input.plan.positionAccount.lowerBinId,
    upperBinId: input.plan.positionAccount.upperBinId,
    positionBase: projectWallet,
  });
  const destinations = {
    projectWalletAddress: projectWallet.toBase58(),
    projectTokenAccounts: new Set([
      projectTokenAccount.toBase58(),
      wrappedSolAccount.toBase58(),
    ]),
    founderWithdrawalAddress: founderWithdrawal.toBase58(),
    founderTokenAccounts: new Set<string>(),
    feeTreasuryAddress: feeTreasury.toBase58(),
    feeTreasuryTokenAccounts: new Set<string>(),
    poolProgramAccounts,
  };
  const createPool: ExecutionRequest = {
    projectWalletId: input.projectWalletId,
    idempotencyKey: `${input.idempotencyPrefix}:create-pool`,
    action: 'CREATE_POOL',
    notionalSol: input.plan.creationCost.knownRequiredAccountRentSol,
    destinations,
    detail: {
      tokenXMint: projectToken.toBase58(),
      tokenYMint: NATIVE_MINT.toBase58(),
      poolAddress: poolAddress.toBase58(),
      binStep: input.plan.pool.binStepBps,
      activeId: input.plan.price.activeBinId,
      feeBps: input.plan.pool.baseFeeBps,
      poolType: input.poolCreation.mode === 'STANDARD' ? 'STANDARD' : 'CUSTOMIZABLE',
      ...(presetParameter ? { presetParameter: presetParameter.toBase58() } : {}),
    },
  };
  const openPosition: ExecutionRequest = {
    projectWalletId: input.projectWalletId,
    idempotencyKey: `${input.idempotencyPrefix}:open-position`,
    action: 'OPEN_POSITION',
    notionalSol: input.plan.deposit.initialLiquidityValueSol,
    destinations,
    detail: {
      poolAddress: poolAddress.toBase58(),
      positionAddress: positionAddress.toBase58(),
      lowerBinId: input.plan.positionAccount.lowerBinId,
      upperBinId: input.plan.positionAccount.upperBinId,
      centerBinId: input.plan.price.activeBinId,
      fundedLowerBinId: input.plan.fundedRange.lowerBinId,
      fundedUpperBinId: input.plan.fundedRange.upperBinId,
      distributionShape: input.plan.distributionShape,
      tokenXAmount: tokenXAmount.toString(),
      tokenYAmount: tokenYAmount.toString(),
      walletSolLamports: walletSolLamports.toString(),
      nativeSolLamports: tokenYAmount.toString(),
      gasReserveLamports: gasReserveLamports.toString(),
      positionRole: PERMANENT_INITIAL_POSITION_ROLE,
      initiatedBy: 'SYSTEM',
    },
  };
  return {
    status: 'UNSIGNED_PREVIEW',
    cluster: 'devnet',
    poolType: input.poolCreation.mode,
    matchesRequiredPoolType: input.poolCreation.mode === 'STANDARD',
    orientation: {
      tokenX: 'PROJECT_TOKEN',
      tokenY: 'WRAPPED_SOL',
      priceUnit: 'SOL_PER_PROJECT_TOKEN',
    },
    poolAddress: poolAddress.toBase58(),
    positionAddress: positionAddress.toBase58(),
    atomicAmounts: {
      tokenX: tokenXAmount.toString(),
      tokenY: tokenYAmount.toString(),
      walletSol: walletSolLamports.toString(),
      gasReserve: gasReserveLamports.toString(),
    },
    walletCoversKnownMinimum: walletSolLamports >= knownMinimumLamports,
    exactNetworkCostRequiresPreflight: true,
    automaticInitialPositionManagement: false,
    requests: [createPool, openPosition],
  };
}
