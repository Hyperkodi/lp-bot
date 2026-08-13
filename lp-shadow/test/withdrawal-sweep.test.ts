import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  WithdrawalSweepBuilder,
  WithdrawalSweepChainStateReader,
  inspectTransaction,
  STANDARD_ALLOWED_PROGRAM_IDS,
  type ExecutionRequest,
  type WithdrawalSweepBalanceSource,
} from '../src/execution/index.js';

const address = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
const wallet = address(1);
const founder = address(2);
const sourceAta = address(3);
const founderAta = address(4);
const mint = address(5);

class Balances implements WithdrawalSweepBalanceSource {
  walletLamports = 1_000_000_000;
  tokenAmount = 123n;
  tokenExists = true;
  async solLamports() {
    return this.walletLamports;
  }
  async tokenAccount(value: PublicKey) {
    expect(value).toEqual(sourceAta);
    return this.tokenExists ? { amount: this.tokenAmount, mint, decimals: 6 } : null;
  }
}

function request(): ExecutionRequest {
  return {
    projectWalletId: 'wallet-1',
    idempotencyKey: 'withdraw:sweep',
    action: 'WITHDRAW',
    notionalSol: 1,
    destinations: {
      projectWalletAddress: wallet.toBase58(),
      projectTokenAccounts: new Set([sourceAta.toBase58()]),
      founderWithdrawalAddress: founder.toBase58(),
      founderTokenAccounts: new Set([founderAta.toBase58()]),
      feeTreasuryAddress: address(6).toBase58(),
      feeTreasuryTokenAccounts: new Set(),
      poolProgramAccounts: new Set(),
    },
    detail: {
      sweep: true,
      projectWalletAddress: wallet.toBase58(),
      tokenAccounts: [
        { source: sourceAta.toBase58(), destination: founderAta.toBase58(), mint: mint.toBase58(), decimals: 6 },
      ],
      finalFeeLamports: 5_000,
      expectedRemainingLamports: 0,
    },
  };
}

describe('full withdrawal sweep', () => {
  it('transfers every token, closes its account to the founder, and sends SOL minus the final fee', async () => {
    const balances = new Balances();
    const builder = new WithdrawalSweepBuilder(balances);
    const built = await builder.build(request());
    expect(builder.source).toBe('WITHDRAWAL_SWEEP');
    expect(built.transactions).toHaveLength(1);
    expect(built.transactions[0]?.notionalSol).toBeCloseTo(0.999995);
    expect(() =>
      inspectTransaction(built.transactions[0]!.transaction, {
        action: 'WITHDRAW',
        allowedProgramIds: STANDARD_ALLOWED_PROGRAM_IDS,
        destinations: request().destinations,
      }),
    ).not.toThrow();
  });

  it('reconciles only after token accounts are closed and no spendable SOL remains', async () => {
    const balances = new Balances();
    const reader = new WithdrawalSweepChainStateReader(balances);
    await expect(
      reader.read({
        id: 'intent',
        projectWalletId: 'wallet-1',
        idempotencyKey: 'withdraw:sweep',
        action: 'WITHDRAW',
        notionalSol: 1,
        status: 'UNKNOWN',
        detail: request().detail,
      }),
    ).resolves.toMatchObject({ state: 'NOT_APPLIED' });

    balances.walletLamports = 0;
    balances.tokenExists = false;
    await expect(
      reader.read({
        id: 'intent',
        projectWalletId: 'wallet-1',
        idempotencyKey: 'withdraw:sweep',
        action: 'WITHDRAW',
        notionalSol: 1,
        status: 'UNKNOWN',
        detail: request().detail,
      }),
    ).resolves.toMatchObject({ state: 'APPLIED' });
  });
});
