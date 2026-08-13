import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CloudKmsAdapter,
  LocalKmsAdapter,
  createEncryptedWallet,
  signTransaction,
} from '../src/custody/index.js';

const masterKey = Buffer.alloc(32, 7).toString('base64');

describe('local envelope encryption', () => {
  it('requires an explicit 32-byte master key', () => {
    expect(() => LocalKmsAdapter.fromEnvironment({})).toThrow(/LPBOT_LOCAL_KMS_MASTER_KEY/);
    expect(() =>
      LocalKmsAdapter.fromEnvironment({ LPBOT_LOCAL_KMS_MASTER_KEY: 'not-base64' }),
    ).toThrow(/32 bytes/);
  });

  it('generates independent encrypted project wallets without exposing a signer', async () => {
    const kms = LocalKmsAdapter.fromEnvironment({ LPBOT_LOCAL_KMS_MASTER_KEY: masterKey });
    const first = await createEncryptedWallet(kms);
    const second = await createEncryptedWallet(kms);

    expect(new PublicKey(first.publicKey).toBase58()).toBe(first.publicKey);
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.keyCiphertext).not.toEqual(second.keyCiphertext);
    expect(first.encryptedDataKey).not.toEqual(second.encryptedDataKey);
    expect(Object.keys(first).sort()).toEqual([
      'encryptedDataKey',
      'keyCiphertext',
      'kmsKeyId',
      'publicKey',
    ]);
  });

  it('decrypts only long enough to sign and returns the signed transaction', async () => {
    const kms = LocalKmsAdapter.fromEnvironment({ LPBOT_LOCAL_KMS_MASTER_KEY: masterKey });
    const wallet = await createEncryptedWallet(kms);
    const message = new TransactionMessage({
      payerKey: new PublicKey(wallet.publicKey),
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);

    const signed = await signTransaction(kms, wallet, transaction, 'devnet');

    expect(signed).toBe(transaction);
    expect([...signed.signatures[0]!].some((byte) => byte !== 0)).toBe(true);
    expect(wallet.keyCiphertext).toEqual(expect.any(Uint8Array));
  });

  it('rejects ciphertext tampering before a signer can be constructed', async () => {
    const kms = LocalKmsAdapter.fromEnvironment({ LPBOT_LOCAL_KMS_MASTER_KEY: masterKey });
    const wallet = await createEncryptedWallet(kms);
    wallet.keyCiphertext[wallet.keyCiphertext.length - 1]! ^= 1;
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(wallet.publicKey),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [],
      }).compileToV0Message(),
    );

    await expect(signTransaction(kms, wallet, transaction, 'devnet')).rejects.toThrow(/authenticate|decrypt/i);
    expect([...transaction.signatures[0]!].every((byte) => byte === 0)).toBe(true);
  });
});

describe('cloud KMS boundary', () => {
  it('stays an explicit stub until the deployment KMS is chosen', async () => {
    const adapter = new CloudKmsAdapter();
    await expect(adapter.generateDataKey()).rejects.toThrow(/TODO.*KMS/i);
    await expect(adapter.decryptDataKey(Uint8Array.of(1))).rejects.toThrow(/TODO.*KMS/i);
  });
});
