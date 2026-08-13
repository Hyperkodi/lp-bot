import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { decryptEnvelope, encryptEnvelope } from './crypto.js';
import type { EncryptedWallet, KmsAdapter, SignableTransaction } from './types.js';

const walletAad = (publicKey: string) => Buffer.from(`armara:project-wallet:${publicKey}:v1`);

export async function createEncryptedWallet(kms: KmsAdapter): Promise<EncryptedWallet> {
  const signer = Keypair.generate();
  const publicKey = signer.publicKey.toBase58();
  const secretCopy = Uint8Array.from(signer.secretKey);
  let dataKey: Awaited<ReturnType<KmsAdapter['generateDataKey']>> | null = null;
  try {
    dataKey = await kms.generateDataKey();
    return {
      publicKey,
      keyCiphertext: encryptEnvelope(dataKey.plaintextDataKey, secretCopy, walletAad(publicKey)),
      encryptedDataKey: Uint8Array.from(dataKey.encryptedDataKey),
      kmsKeyId: kms.keyId,
    };
  } finally {
    signer.secretKey.fill(0);
    secretCopy.fill(0);
    dataKey?.plaintextDataKey.fill(0);
  }
}

/** Sign without returning or accepting a signer. Plaintext exists only in this
 * stack frame and every buffer, including the Keypair's copy, is zeroed. */
export async function signTransaction<T extends SignableTransaction>(
  kms: KmsAdapter,
  wallet: EncryptedWallet,
  transaction: T,
  cluster: 'devnet',
): Promise<T> {
  if (cluster !== 'devnet') throw new Error('custodial signing is devnet-only');
  if (wallet.kmsKeyId !== kms.keyId) {
    throw new Error(`wallet KMS ${wallet.kmsKeyId} does not match adapter ${kms.keyId}`);
  }

  const dataKey = await kms.decryptDataKey(wallet.encryptedDataKey);
  let secret: Uint8Array | null = null;
  let signer: Keypair | null = null;
  try {
    secret = decryptEnvelope(dataKey, wallet.keyCiphertext, walletAad(wallet.publicKey));
    signer = Keypair.fromSecretKey(secret);
    if (signer.publicKey.toBase58() !== wallet.publicKey) {
      throw new Error('decrypted wallet does not match the registered public key');
    }
    if (transaction instanceof VersionedTransaction) transaction.sign([signer]);
    else if (transaction instanceof Transaction) transaction.sign(signer);
    else throw new Error('unsupported Solana transaction type');
    return transaction;
  } finally {
    signer?.secretKey.fill(0);
    secret?.fill(0);
    dataKey.fill(0);
  }
}
