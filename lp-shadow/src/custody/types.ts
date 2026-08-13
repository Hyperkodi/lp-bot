import type { Transaction, VersionedTransaction } from '@solana/web3.js';

export type GeneratedDataKey = {
  plaintextDataKey: Uint8Array;
  encryptedDataKey: Uint8Array;
};

/** The only deployment-specific custody seam. The real provider remains an
 * open product decision; implementations belong in this directory. */
export interface KmsAdapter {
  readonly keyId: string;
  generateDataKey(): Promise<GeneratedDataKey>;
  decryptDataKey(encryptedDataKey: Uint8Array): Promise<Uint8Array>;
}

export type EncryptedWallet = {
  publicKey: string;
  keyCiphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  kmsKeyId: string;
};

export type SignableTransaction = Transaction | VersionedTransaction;

