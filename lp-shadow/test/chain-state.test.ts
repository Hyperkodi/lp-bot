import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  DevnetMeteoraChainStateReader,
  type MeteoraChainSnapshot,
  type MeteoraChainStateSource,
  type StoredIntent,
} from '../src/execution/index.js';

const address = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();

function intent(action: string, detail: Record<string, unknown>): StoredIntent {
  return {
    id: 'intent-1',
    projectWalletId: 'wallet-1',
    idempotencyKey: 'test',
    action,
    notionalSol: 1,
    status: 'UNKNOWN',
    detail,
  };
}

class Source implements MeteoraChainStateSource {
  constructor(readonly snapshot: MeteoraChainSnapshot) {}
  async read() {
    return this.snapshot;
  }
}

describe('Meteora chain-state reconciliation', () => {
  it('recognizes an applied open position from exact on-chain range and liquidity', async () => {
    const detail = {
      poolAddress: address(1),
      positionAddress: address(2),
      lowerBinId: 65,
      upperBinId: 134,
    };
    const reader = new DevnetMeteoraChainStateReader(
      new Source({ poolExists: true, positionExists: true, lowerBinId: 65, upperBinId: 134, hasLiquidity: true }),
    );
    await expect(reader.read(intent('OPEN_POSITION', detail))).resolves.toMatchObject({ state: 'APPLIED' });
  });

  it('reports initialized-but-empty position as partial', async () => {
    const detail = {
      poolAddress: address(1),
      positionAddress: address(2),
      lowerBinId: 65,
      upperBinId: 134,
    };
    const reader = new DevnetMeteoraChainStateReader(
      new Source({ poolExists: true, positionExists: true, lowerBinId: 65, upperBinId: 134, hasLiquidity: false }),
    );
    await expect(reader.read(intent('OPEN_POSITION', detail))).resolves.toEqual({
      state: 'PARTIAL',
      detail: expect.objectContaining({ completedPhases: ['initialize-position'] }),
    });
  });

  it('recognizes a completed withdrawal only when the position is gone', async () => {
    const detail = { poolAddress: address(1), positionAddress: address(2), lowerBinId: 65, upperBinId: 134 };
    const reader = new DevnetMeteoraChainStateReader(
      new Source({ poolExists: true, positionExists: false, hasLiquidity: false }),
    );
    await expect(reader.read(intent('WITHDRAW', detail))).resolves.toMatchObject({ state: 'APPLIED' });
  });

  it('returns unknown instead of guessing when the source cannot prove state', async () => {
    const reader = new DevnetMeteoraChainStateReader(
      new Source({ poolExists: null, positionExists: null, hasLiquidity: null }),
    );
    await expect(reader.read(intent('CREATE_POOL', { poolAddress: address(1) }))).resolves.toMatchObject({
      state: 'UNKNOWN',
    });
  });
});
