import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  DepositPoller,
  extractDepositEvents,
  type DepositEventStore,
  type DepositHistorySource,
  type ObservedDeposit,
} from '../src/deposit/index.js';

const wallet = new PublicKey(Uint8Array.from({ length: 32 }, () => 1));

const transaction = {
  blockTime: 1_700_000_000,
  accountKeys: [
    new PublicKey(Uint8Array.from({ length: 32 }, () => 2)).toBase58(),
    wallet.toBase58(),
    new PublicKey(Uint8Array.from({ length: 32 }, () => 3)).toBase58(),
    new PublicKey(Uint8Array.from({ length: 32 }, () => 4)).toBase58(),
    new PublicKey(Uint8Array.from({ length: 32 }, () => 5)).toBase58(),
  ],
  preBalances: [1_000, 10, 0, 0, 0],
  postBalances: [900, 110, 0, 0, 0],
  preTokenBalances: [
    { accountIndex: 2, mint: 'PROJECT', owner: wallet.toBase58(), amount: '5' },
    { accountIndex: 4, mint: 'OUTBOUND', owner: wallet.toBase58(), amount: '20' },
  ],
  postTokenBalances: [
    { accountIndex: 2, mint: 'PROJECT', owner: wallet.toBase58(), amount: '25' },
    { accountIndex: 3, mint: 'UNEXPECTED', owner: wallet.toBase58(), amount: '9' },
    { accountIndex: 4, mint: 'OUTBOUND', owner: wallet.toBase58(), amount: '10' },
  ],
};

describe('devnet deposit polling', () => {
  it('extracts only positive SOL and token balance changes for the project wallet', () => {
    const events = extractDepositEvents(wallet, 'signature-1', transaction);
    expect(events).toEqual([
      expect.objectContaining({ signature: 'signature-1', eventIndex: 0, assetMint: null, amount: 100n }),
      expect.objectContaining({ signature: 'signature-1', eventIndex: 3, assetMint: 'PROJECT', amount: 20n }),
      expect.objectContaining({ signature: 'signature-1', eventIndex: 4, assetMint: 'UNEXPECTED', amount: 9n }),
    ]);
    expect(events.some((event) => event.assetMint === 'OUTBOUND')).toBe(false);
  });

  it('processes history oldest-first and relies on stable keys for idempotency', async () => {
    const source: DepositHistorySource = {
      async signatures() {
        return ['signature-2', 'signature-1'];
      },
      async transaction(signature) {
        return { ...transaction, blockTime: signature === 'signature-1' ? 1 : 2 };
      },
    };
    const inserted = new Map<string, ObservedDeposit>();
    const store: DepositEventStore = {
      async append(_projectWalletId, events) {
        let count = 0;
        for (const event of events) {
          const key = `${event.signature}:${event.eventIndex}`;
          if (!inserted.has(key)) {
            inserted.set(key, event);
            count += 1;
          }
        }
        return count;
      },
    };
    const poller = new DepositPoller(source, store);
    expect(await poller.poll('project-wallet-1', wallet)).toBe(6);
    expect(await poller.poll('project-wallet-1', wallet)).toBe(0);
    expect([...inserted.values()].map((event) => event.signature)).toEqual([
      'signature-1',
      'signature-1',
      'signature-1',
      'signature-2',
      'signature-2',
      'signature-2',
    ]);
  });
});
