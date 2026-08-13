import { Connection, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export type DepositTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: string;
};

export type DepositTransaction = {
  blockTime: number | null;
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: DepositTokenBalance[];
  postTokenBalances: DepositTokenBalance[];
};

export type ObservedDeposit = {
  signature: string;
  eventIndex: number;
  assetMint: string | null;
  amount: bigint;
  observedAt: Date;
  kind: 'DEPOSIT';
  detail: { accountIndex: number; rawAmount: string };
};

export interface DepositHistorySource {
  signatures(wallet: PublicKey): Promise<string[]>;
  transaction(signature: string): Promise<DepositTransaction | null>;
}

export interface DepositEventStore {
  append(projectWalletId: string, events: readonly ObservedDeposit[]): Promise<number>;
}

function tokenBalancesByAccount(balances: readonly DepositTokenBalance[]) {
  const map = new Map<number, DepositTokenBalance>();
  for (const balance of balances) map.set(balance.accountIndex, balance);
  return map;
}

export function extractDepositEvents(
  wallet: PublicKey,
  signature: string,
  transaction: DepositTransaction,
): ObservedDeposit[] {
  const walletAddress = wallet.toBase58();
  const observedAt = new Date((transaction.blockTime ?? 0) * 1_000);
  const events: ObservedDeposit[] = [];
  const walletIndex = transaction.accountKeys.indexOf(walletAddress);
  if (walletIndex >= 0) {
    const pre = transaction.preBalances[walletIndex] ?? 0;
    const post = transaction.postBalances[walletIndex] ?? 0;
    if (post > pre) {
      const amount = BigInt(post - pre);
      events.push({
        signature,
        eventIndex: 0,
        assetMint: null,
        amount,
        observedAt,
        kind: 'DEPOSIT',
        detail: { accountIndex: walletIndex, rawAmount: amount.toString() },
      });
    }
  }

  const before = tokenBalancesByAccount(transaction.preTokenBalances);
  const after = tokenBalancesByAccount(transaction.postTokenBalances);
  const indexes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  for (const accountIndex of indexes) {
    const pre = before.get(accountIndex);
    const post = after.get(accountIndex);
    const owner = post?.owner ?? pre?.owner;
    if (owner !== walletAddress) continue;
    const preAmount = BigInt(pre?.amount ?? 0);
    const postAmount = BigInt(post?.amount ?? 0);
    if (postAmount <= preAmount) continue;
    const amount = postAmount - preAmount;
    events.push({
      signature,
      eventIndex: accountIndex + 1,
      assetMint: post?.mint ?? pre?.mint ?? null,
      amount,
      observedAt,
      kind: 'DEPOSIT',
      detail: { accountIndex, rawAmount: amount.toString() },
    });
  }
  return events;
}

export class DepositPoller {
  constructor(
    private readonly source: DepositHistorySource,
    private readonly store: DepositEventStore,
  ) {}

  async poll(projectWalletId: string, wallet: PublicKey): Promise<number> {
    const signatures = await this.source.signatures(wallet);
    let inserted = 0;
    for (const signature of [...signatures].reverse()) {
      const transaction = await this.source.transaction(signature);
      if (!transaction) continue;
      inserted += await this.store.append(
        projectWalletId,
        extractDepositEvents(wallet, signature, transaction),
      );
    }
    return inserted;
  }
}

function convertParsedTransaction(transaction: ParsedTransactionWithMeta): DepositTransaction {
  const meta = transaction.meta;
  if (!meta) throw new Error('confirmed transaction has no metadata');
  const accountKeys = transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
  const convert = (balance: NonNullable<typeof meta.preTokenBalances>[number]): DepositTokenBalance => ({
    accountIndex: balance.accountIndex,
    mint: balance.mint,
    owner: balance.owner,
    amount: balance.uiTokenAmount.amount,
  });
  return {
    blockTime: transaction.blockTime ?? null,
    accountKeys,
    preBalances: meta.preBalances,
    postBalances: meta.postBalances,
    preTokenBalances: (meta.preTokenBalances ?? []).map(convert),
    postTokenBalances: (meta.postTokenBalances ?? []).map(convert),
  };
}

export class DevnetDepositHistorySource implements DepositHistorySource {
  private readonly connection: Connection;

  constructor(endpoint: string) {
    if (!endpoint.toLowerCase().includes('devnet')) throw new Error('deposit polling is devnet-only');
    this.connection = new Connection(endpoint, 'confirmed');
  }

  async signatures(wallet: PublicKey): Promise<string[]> {
    return (await this.connection.getSignaturesForAddress(wallet, { limit: 1_000 }, 'confirmed')).map(
      (entry) => entry.signature,
    );
  }

  async transaction(signature: string): Promise<DepositTransaction | null> {
    const transaction = await this.connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    return transaction ? convertParsedTransaction(transaction) : null;
  }
}

export class PrismaDepositEventStore implements DepositEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(projectWalletId: string, events: readonly ObservedDeposit[]): Promise<number> {
    let inserted = 0;
    for (const event of events) {
      const result = await this.prisma.depositEvent.createMany({
        data: [
          {
            projectWalletId,
            signature: event.signature,
            eventIndex: event.eventIndex,
            assetMint: event.assetMint,
            amount: event.amount.toString(),
            kind: event.kind,
            observedAt: event.observedAt,
            detailJson: event.detail,
          },
        ],
        skipDuplicates: true,
      });
      inserted += result.count;
    }
    return inserted;
  }
}
