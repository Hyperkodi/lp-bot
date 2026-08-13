import type DLMMClass from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import { DLMM } from '../poller/dlmmSdk.js';
import type { ChainState, ChainStateReader, StoredIntent } from './types.js';

export type MeteoraChainSnapshot = {
  poolExists: boolean | null;
  positionExists: boolean | null;
  lowerBinId?: number;
  upperBinId?: number;
  hasLiquidity: boolean | null;
};

export interface MeteoraChainStateSource {
  read(intent: StoredIntent): Promise<MeteoraChainSnapshot>;
}

function detailKey(intent: StoredIntent, name: string): string | null {
  const value = intent.detail?.[name];
  return typeof value === 'string' ? value : null;
}

function detailInteger(intent: StoredIntent, name: string): number | null {
  const value = intent.detail?.[name];
  return Number.isSafeInteger(value) ? (value as number) : null;
}

export class DevnetMeteoraChainStateReader implements ChainStateReader {
  constructor(private readonly source: MeteoraChainStateSource) {}

  async read(intent: StoredIntent): Promise<ChainState> {
    let snapshot: MeteoraChainSnapshot;
    try {
      snapshot = await this.source.read(intent);
    } catch (error) {
      return { state: 'UNKNOWN', detail: { error: String(error) } };
    }
    const detail = { ...snapshot };
    if (snapshot.poolExists === null) return { state: 'UNKNOWN', detail };

    if (intent.action === 'CREATE_POOL') {
      return { state: snapshot.poolExists ? 'APPLIED' : 'NOT_APPLIED', detail };
    }

    if (snapshot.positionExists === null || snapshot.hasLiquidity === null) {
      return { state: 'UNKNOWN', detail };
    }
    if (intent.action === 'WITHDRAW' || intent.action === 'EXIT') {
      return { state: snapshot.positionExists ? 'NOT_APPLIED' : 'APPLIED', detail };
    }

    const expectedLower = detailInteger(intent, 'lowerBinId');
    const expectedUpper = detailInteger(intent, 'upperBinId');
    if (
      snapshot.positionExists &&
      expectedLower !== null &&
      expectedUpper !== null &&
      (snapshot.lowerBinId !== expectedLower || snapshot.upperBinId !== expectedUpper)
    ) {
      return { state: 'UNKNOWN', detail: { ...detail, error: 'position range differs from intent' } };
    }
    if (snapshot.positionExists && snapshot.hasLiquidity) return { state: 'APPLIED', detail };
    if (snapshot.positionExists) {
      return {
        state: 'PARTIAL',
        detail: { ...detail, completedPhases: ['initialize-position'] },
      };
    }
    return { state: 'NOT_APPLIED', detail };
  }
}

export class SolanaMeteoraChainStateSource implements MeteoraChainStateSource {
  private readonly connection: Connection;

  constructor(endpoint: string) {
    if (!endpoint.toLowerCase().includes('devnet')) throw new Error('chain reconciliation is devnet-only');
    this.connection = new Connection(endpoint, 'confirmed');
  }

  async read(intent: StoredIntent): Promise<MeteoraChainSnapshot> {
    const poolText = detailKey(intent, 'poolAddress');
    if (!poolText) throw new Error('execution intent has no poolAddress');
    const poolAddress = new PublicKey(poolText);
    const poolExists = Boolean(await this.connection.getAccountInfo(poolAddress, 'confirmed'));
    if (!poolExists || intent.action === 'CREATE_POOL') {
      return { poolExists, positionExists: false, hasLiquidity: false };
    }
    const positionText = detailKey(intent, 'positionAddress');
    if (!positionText) throw new Error('execution intent has no positionAddress');
    const positionAddress = new PublicKey(positionText);
    const positionAccount = await this.connection.getAccountInfo(positionAddress, 'confirmed');
    if (!positionAccount) return { poolExists: true, positionExists: false, hasLiquidity: false };

    const pool = (await DLMM.create(this.connection, poolAddress, { cluster: 'devnet' })) as DLMMClass;
    const position = await pool.getPosition(positionAddress);
    const { positionData } = position;
    return {
      poolExists: true,
      positionExists: true,
      lowerBinId: positionData.lowerBinId,
      upperBinId: positionData.upperBinId,
      hasLiquidity: BigInt(positionData.totalXAmount) > 0n || BigInt(positionData.totalYAmount) > 0n,
    };
  }
}
