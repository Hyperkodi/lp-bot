import {
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getMint,
  unpackAccount,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type {
  BuiltExecution,
  ChainStateReader,
  ExecutionBuilder,
  ExecutionRequest,
  StoredIntent,
} from './types.js';

export type SweepTokenAccount = { amount: bigint; mint: PublicKey; decimals: number };

export interface WithdrawalSweepBalanceSource {
  solLamports(wallet: PublicKey): Promise<number>;
  tokenAccount(address: PublicKey): Promise<SweepTokenAccount | null>;
}

type SweepAsset = {
  source: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
  decimals: number;
};

function publicKey(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a public key`);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a public key`);
  }
}

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function sweepAssets(intent: { detail?: Record<string, unknown> }): SweepAsset[] {
  const rows = intent.detail?.tokenAccounts;
  if (!Array.isArray(rows)) throw new Error('withdrawal sweep requires tokenAccounts');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`tokenAccounts[${index}] must be an object`);
    }
    const value = row as Record<string, unknown>;
    return {
      source: publicKey(value.source, `tokenAccounts[${index}].source`),
      destination: publicKey(value.destination, `tokenAccounts[${index}].destination`),
      mint: publicKey(value.mint, `tokenAccounts[${index}].mint`),
      decimals: integer(value.decimals, `tokenAccounts[${index}].decimals`),
    };
  });
}

export class WithdrawalSweepBuilder implements ExecutionBuilder {
  readonly source = 'WITHDRAWAL_SWEEP' as const;

  constructor(private readonly balances: WithdrawalSweepBalanceSource) {}

  async build(request: ExecutionRequest): Promise<BuiltExecution> {
    if (request.action !== 'WITHDRAW' || request.detail?.sweep !== true) {
      throw new Error('withdrawal sweep builder accepts only explicit WITHDRAW sweep requests');
    }
    const wallet = publicKey(request.destinations.projectWalletAddress, 'project wallet');
    const founder = publicKey(request.destinations.founderWithdrawalAddress, 'founder withdrawal address');
    const transaction = new Transaction();
    for (const asset of sweepAssets(request)) {
      const account = await this.balances.tokenAccount(asset.source);
      if (!account) continue;
      if (!account.mint.equals(asset.mint) || account.decimals !== asset.decimals) {
        throw new Error(`withdrawal token account ${asset.source.toBase58()} differs from intent`);
      }
      if (account.amount > 0n) {
        transaction.add(
          createTransferCheckedInstruction(
            asset.source,
            asset.mint,
            asset.destination,
            wallet,
            account.amount,
            asset.decimals,
          ),
        );
      }
      transaction.add(createCloseAccountInstruction(asset.source, founder, wallet));
    }
    const walletLamports = await this.balances.solLamports(wallet);
    const finalFeeLamports = integer(request.detail.finalFeeLamports, 'finalFeeLamports');
    if (walletLamports <= finalFeeLamports) throw new Error('project wallet cannot pay its final network fee');
    const transferLamports = walletLamports - finalFeeLamports;
    transaction.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: founder, lamports: transferLamports }));
    return {
      transactions: [
        {
          phase: 'founder-sweep',
          notionalSol: transferLamports / 1_000_000_000,
          transaction,
        },
      ],
    };
  }

  buildCompletion(request: ExecutionRequest) {
    return this.build(request);
  }
}

export class WithdrawalSweepChainStateReader implements ChainStateReader {
  constructor(private readonly balances: WithdrawalSweepBalanceSource) {}

  async read(intent: StoredIntent) {
    try {
      const wallet = publicKey(intent.detail?.projectWalletAddress, 'projectWalletAddress');
      const expectedRemaining = integer(
        intent.detail?.expectedRemainingLamports,
        'expectedRemainingLamports',
      );
      const tokenAccounts = await Promise.all(
        sweepAssets(intent).map((asset) => this.balances.tokenAccount(asset.source)),
      );
      const lamports = await this.balances.solLamports(wallet);
      const applied = tokenAccounts.every((account) => account === null) && lamports <= expectedRemaining;
      return {
        state: applied ? ('APPLIED' as const) : ('NOT_APPLIED' as const),
        detail: { lamports, openTokenAccounts: tokenAccounts.filter(Boolean).length },
      };
    } catch (error) {
      return { state: 'UNKNOWN' as const, detail: { error: String(error) } };
    }
  }
}

export class SolanaWithdrawalSweepBalanceSource implements WithdrawalSweepBalanceSource {
  private readonly connection: Connection;

  constructor(endpoint: string) {
    if (!endpoint.toLowerCase().includes('devnet')) throw new Error('withdrawal sweep is devnet-only');
    this.connection = new Connection(endpoint, 'confirmed');
  }

  solLamports(wallet: PublicKey) {
    return this.connection.getBalance(wallet, 'confirmed');
  }

  async tokenAccount(address: PublicKey): Promise<SweepTokenAccount | null> {
    const info = await this.connection.getAccountInfo(address, 'confirmed');
    if (!info) return null;
    const account = unpackAccount(address, info, info.owner);
    const mint = await getMint(this.connection, account.mint, 'confirmed', info.owner);
    return { amount: account.amount, mint: account.mint, decimals: mint.decimals };
  }
}
