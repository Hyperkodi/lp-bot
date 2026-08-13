import { PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  GAS_RESERVE_LAMPORTS,
  MeteoraDevnetRecipes,
  assertGasReserve,
  classicPositionRange,
  type MeteoraPoolFacade,
  type MeteoraSdkFacade,
  type ExecutionRequest,
} from '../src/execution/index.js';

const address = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
const wallet = address(1);
const poolAddress = address(2);
const positionAddress = address(3);
const tokenX = address(4);
const tokenY = address(5);

function tx() {
  return new Transaction({ feePayer: wallet, recentBlockhash: '11111111111111111111111111111111' });
}

function request(action: ExecutionRequest['action'], detail: Record<string, unknown>): ExecutionRequest {
  return {
    projectWalletId: 'wallet-1',
    idempotencyKey: `test:${action}`,
    action,
    notionalSol: 2,
    destinations: {
      projectWalletAddress: wallet.toBase58(),
      founderWithdrawalAddress: address(6).toBase58(),
      founderTokenAccounts: new Set(),
      feeTreasuryAddress: address(7).toBase58(),
      feeTreasuryTokenAccounts: new Set(),
      poolProgramAccounts: new Set([poolAddress.toBase58()]),
    },
    detail,
  };
}

class FakePool implements MeteoraPoolFacade {
  calls: Array<{ method: string; value: Record<string, unknown> }> = [];

  async getActiveBin() {
    return { binId: 100, price: '1' };
  }
  async initializePositionByOperator(value: Record<string, unknown>) {
    this.calls.push({ method: 'initialize', value });
    return tx();
  }
  async addLiquidityByStrategy(value: Record<string, unknown>) {
    this.calls.push({ method: 'add', value });
    return tx();
  }
  async removeLiquidity(value: Record<string, unknown>) {
    this.calls.push({ method: 'remove', value });
    return [tx()];
  }
  async getPosition(publicKey: PublicKey) {
    this.calls.push({ method: 'get-position', value: { publicKey } });
    return { publicKey, positionData: {} };
  }
  async claimAllRewardsByPosition(value: Record<string, unknown>) {
    this.calls.push({ method: 'claim', value });
    return [tx()];
  }
}

class FakeSdk implements MeteoraSdkFacade {
  readonly pool = new FakePool();
  createArgs: Record<string, unknown> | null = null;

  async buildCreatePool(value: Record<string, unknown>) {
    this.createArgs = value;
    return tx();
  }
  async loadPool() {
    return this.pool;
  }
  derivePositionAddress() {
    return positionAddress;
  }
}

describe('Meteora devnet recipes', () => {
  it('centres an exact 70-bin classic position', () => {
    expect(classicPositionRange(100)).toEqual({ lowerBinId: 65, upperBinId: 134, width: 70 });
  });

  it('keeps the gas reserve out of position sizing', () => {
    expect(() => assertGasReserve(1_000_000_000n, 950_000_000n)).not.toThrow();
    expect(() => assertGasReserve(1_000_000_000n, 950_000_001n)).toThrow(/gas reserve/i);
    expect(GAS_RESERVE_LAMPORTS).toBe(50_000_000n);
  });

  it('builds pool creation through the devnet SDK facade', async () => {
    const sdk = new FakeSdk();
    const recipes = new MeteoraDevnetRecipes(sdk);
    const built = await recipes.build(
      request('CREATE_POOL', {
        tokenXMint: tokenX.toBase58(),
        tokenYMint: tokenY.toBase58(),
        binStep: 25,
        activeId: 0,
        feeBps: 30,
      }),
    );

    expect(sdk.createArgs).toMatchObject({
      tokenXMint: tokenX,
      tokenYMint: tokenY,
      creator: wallet,
      binStep: 25,
      activeId: 0,
      feeBps: 30,
    });
    expect(built.transactions.map((item) => item.phase)).toEqual(['create-pool']);
  });

  it('opens and funds a 70-bin position using only the project wallet signer', async () => {
    const sdk = new FakeSdk();
    const recipes = new MeteoraDevnetRecipes(sdk);
    const built = await recipes.build(
      request('OPEN_POSITION', {
        poolAddress: poolAddress.toBase58(),
        tokenXAmount: '1000',
        tokenYAmount: '2000',
        walletSolLamports: '1000000000',
        nativeSolLamports: '900000000',
      }),
    );

    expect(built.transactions.map((item) => item.phase)).toEqual(['initialize-position', 'add-liquidity']);
    const initialize = sdk.pool.calls.find((call) => call.method === 'initialize')?.value;
    expect(initialize).toMatchObject({
      lowerBinId: expect.objectContaining({}),
      positionWidth: expect.objectContaining({}),
      owner: wallet,
      feeOwner: wallet,
      operator: wallet,
      payer: wallet,
      base: wallet,
    });
    expect(String(initialize?.lowerBinId)).toBe('65');
    expect(String(initialize?.positionWidth)).toBe('70');
    const add = sdk.pool.calls.find((call) => call.method === 'add')?.value;
    expect(add).toMatchObject({ positionPubKey: positionAddress, user: wallet });
    expect(add?.strategy).toMatchObject({ minBinId: 65, maxBinId: 134 });
  });

  it('builds full removal with fee claim-and-close and resumes only unfinished phases', async () => {
    const sdk = new FakeSdk();
    const recipes = new MeteoraDevnetRecipes(sdk);
    const withdrawal = request('WITHDRAW', {
      poolAddress: poolAddress.toBase58(),
      positionAddress: positionAddress.toBase58(),
      lowerBinId: 65,
      upperBinId: 134,
    });
    const built = await recipes.build(withdrawal);
    expect(built.transactions.map((item) => item.phase)).toEqual(['remove-liquidity']);
    expect(sdk.pool.calls[0]?.value).toMatchObject({
      user: wallet,
      position: positionAddress,
      fromBinId: 65,
      toBinId: 134,
      shouldClaimAndClose: true,
    });

    const completed = await recipes.buildCompletion(withdrawal, {
      state: 'PARTIAL',
      detail: { completedPhases: ['remove-liquidity'] },
    });
    expect(completed.transactions).toEqual([]);
  });
});
