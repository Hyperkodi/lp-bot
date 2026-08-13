import { Connection, Transaction, type VersionedTransaction } from '@solana/web3.js';
import type { ExecutionRpc } from './types.js';

export class DevnetRpc implements ExecutionRpc {
  readonly cluster = 'devnet' as const;
  readonly endpoint: string;
  private readonly connection: Connection;

  constructor(endpoint: string) {
    if (!endpoint.toLowerCase().includes('devnet')) {
      throw new Error('signed execution is devnet-only; the RPC endpoint must identify devnet');
    }
    this.endpoint = endpoint;
    this.connection = new Connection(endpoint, 'confirmed');
  }

  async simulate(transaction: Transaction | VersionedTransaction): Promise<{ err: unknown; logs?: string[] }> {
    const response =
      transaction instanceof Transaction
        ? await this.connection.simulateTransaction(transaction, [])
        : await this.connection.simulateTransaction(transaction, { sigVerify: false, commitment: 'confirmed' });
    return { err: response.value.err, logs: response.value.logs ?? undefined };
  }

  async send(transaction: Transaction | VersionedTransaction): Promise<string> {
    return this.connection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 0,
    });
  }

  async confirm(signature: string, commitment: 'confirmed' | 'finalized'): Promise<void> {
    const response = await this.connection.confirmTransaction(signature, commitment);
    if (response.value.err) {
      throw new Error(`${commitment} confirmation failed: ${JSON.stringify(response.value.err)}`);
    }
  }
}

