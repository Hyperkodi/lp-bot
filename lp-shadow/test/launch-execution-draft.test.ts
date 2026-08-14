import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { draftLaunchExecution, toAtomicAmount } from '../src/strategy/launchExecutionDraft.js';
import { planInitialLiquidity } from '../src/strategy/launchPlanner.js';

const address = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();

function plan() {
  return planInitialLiquidity({
    tokenAmount: 10_000_000,
    solAmount: 132,
    tokenSupply: 1_000_000_000,
    tokenDecimals: 6,
    solPriceUsd: 75.89,
    binStepBps: 50,
    baseFeeBps: 30,
    distributionShape: 'SPOT',
    totalBins: 69,
    buyerOrderSol: 1,
    maxBuyerImpactBps: 100,
    gasReserveSol: 0.05,
  });
}

describe('unsigned launch execution draft', () => {
  it('converts the reviewed plan to deterministic devnet requests without signing', () => {
    const reviewed = plan();
    const draft = draftLaunchExecution({
      plan: reviewed,
      projectWalletId: 'wallet-1',
      projectWalletAddress: address(1),
      founderWithdrawalAddress: address(2),
      feeTreasuryAddress: address(3),
      projectTokenMint: address(4),
      projectTokenAmount: '10000000',
      solAmount: '132',
      walletSolAmount: '133',
      tokenDecimals: 6,
      idempotencyPrefix: 'launch-draft-1',
      poolCreation: { mode: 'DEVNET_CUSTOMIZABLE_PROXY' },
    });

    expect(draft).toMatchObject({
      status: 'UNSIGNED_PREVIEW',
      cluster: 'devnet',
      poolType: 'DEVNET_CUSTOMIZABLE_PROXY',
      matchesRequiredPoolType: false,
      orientation: {
        tokenX: 'PROJECT_TOKEN',
        tokenY: 'WRAPPED_SOL',
        priceUnit: 'SOL_PER_PROJECT_TOKEN',
      },
      atomicAmounts: {
        tokenX: '10000000000000',
        tokenY: '132000000000',
        walletSol: '133000000000',
        gasReserve: '50000000',
      },
      walletCoversKnownMinimum: true,
      exactNetworkCostRequiresPreflight: true,
      automaticInitialPositionManagement: false,
    });
    expect(draft.requests.map((request) => request.action)).toEqual([
      'CREATE_POOL',
      'OPEN_POSITION',
    ]);
    expect(draft.requests[0].detail).toMatchObject({
      activeId: reviewed.price.activeBinId,
      tokenXMint: address(4),
      tokenYMint: 'So11111111111111111111111111111111111111112',
    });
    expect(draft.requests[1].detail).toMatchObject({
      positionAddress: draft.positionAddress,
      lowerBinId: reviewed.positionAccount.lowerBinId,
      upperBinId: reviewed.positionAccount.upperBinId,
      fundedLowerBinId: reviewed.fundedRange.lowerBinId,
      fundedUpperBinId: reviewed.fundedRange.upperBinId,
      distributionShape: 'SPOT',
      tokenXAmount: '10000000000000',
      tokenYAmount: '132000000000',
      positionRole: 'PERMANENT_INITIAL',
      initiatedBy: 'SYSTEM',
    });
  });

  it('rejects excess precision and an amount that differs from the reviewed plan', () => {
    expect(() => toAtomicAmount('1.0000001', 6, 'token amount')).toThrow(/more than 6/i);
    expect(() =>
      draftLaunchExecution({
        plan: plan(),
        projectWalletId: 'wallet-1',
        projectWalletAddress: address(1),
        founderWithdrawalAddress: address(2),
        feeTreasuryAddress: address(3),
        projectTokenMint: address(4),
        projectTokenAmount: '9999999',
        solAmount: '132',
        walletSolAmount: '133',
        tokenDecimals: 6,
        idempotencyPrefix: 'launch-draft-1',
        poolCreation: { mode: 'DEVNET_CUSTOMIZABLE_PROXY' },
      }),
    ).toThrow(/does not match/i);
  });

  it('derives the production Standard pool only from an explicit verified preset', () => {
    const presetParameter = address(9);
    const draft = draftLaunchExecution({
      plan: plan(),
      projectWalletId: 'wallet-1',
      projectWalletAddress: address(1),
      founderWithdrawalAddress: address(2),
      feeTreasuryAddress: address(3),
      projectTokenMint: address(4),
      projectTokenAmount: '10000000',
      solAmount: '132',
      walletSolAmount: '133',
      tokenDecimals: 6,
      idempotencyPrefix: 'standard-draft-1',
      poolCreation: {
        mode: 'STANDARD',
        preset: {
          address: presetParameter,
          binStepBps: 50,
          baseFeeBps: '30',
          baseFactor: 6_000,
          baseFeePowerFactor: 0,
          concreteFunctionType: 'LIQUIDITY_MINING',
          collectFeeMode: 'INPUT_ONLY',
          source: 'DEVNET_ON_CHAIN_PRESET_PARAMETER_2',
        },
      },
    });

    expect(draft.poolType).toBe('STANDARD');
    expect(draft.matchesRequiredPoolType).toBe(true);
    expect(draft.requests[0].detail).toMatchObject({
      poolType: 'STANDARD',
      presetParameter,
      poolAddress: draft.poolAddress,
    });
  });

  it('rejects a Standard preset whose reviewed economics or mode do not match', () => {
    expect(() => draftLaunchExecution({
      plan: plan(),
      projectWalletId: 'wallet-1',
      projectWalletAddress: address(1),
      founderWithdrawalAddress: address(2),
      feeTreasuryAddress: address(3),
      projectTokenMint: address(4),
      projectTokenAmount: '10000000',
      solAmount: '132',
      walletSolAmount: '133',
      tokenDecimals: 6,
      idempotencyPrefix: 'standard-draft-mismatch',
      poolCreation: {
        mode: 'STANDARD',
        preset: {
          address: address(9),
          binStepBps: 10,
          baseFeeBps: '1000',
          baseFactor: 100_000,
          baseFeePowerFactor: 0,
          concreteFunctionType: 'LIQUIDITY_MINING',
          collectFeeMode: 'INPUT_ONLY',
          source: 'DEVNET_ON_CHAIN_PRESET_PARAMETER_2',
        },
      },
    })).toThrow(/does not match/i);
  });

  it('rejects a mismatched decimal count, wrapped SOL mint, and unsupported token program', () => {
    const base = {
      plan: plan(),
      projectWalletId: 'wallet-1',
      projectWalletAddress: address(1),
      founderWithdrawalAddress: address(2),
      feeTreasuryAddress: address(3),
      projectTokenMint: address(4),
      projectTokenAmount: '10000000',
      solAmount: '132',
      walletSolAmount: '133',
      tokenDecimals: 6,
      idempotencyPrefix: 'invalid-draft',
      poolCreation: { mode: 'DEVNET_CUSTOMIZABLE_PROXY' as const },
    };

    expect(() => draftLaunchExecution({ ...base, tokenDecimals: 9 })).toThrow(/decimals/i);
    expect(() => draftLaunchExecution({
      ...base,
      projectTokenMint: 'So11111111111111111111111111111111111111112',
    })).toThrow(/different from wrapped SOL/i);
    expect(() => draftLaunchExecution({
      ...base,
      projectTokenProgramId: address(8),
    })).toThrow(/SPL Token or Token-2022/i);
  });
});
