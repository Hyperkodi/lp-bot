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
    });

    expect(draft).toMatchObject({
      status: 'UNSIGNED_PREVIEW',
      cluster: 'devnet',
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
      }),
    ).toThrow(/does not match/i);
  });
});
