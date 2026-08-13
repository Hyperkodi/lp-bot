import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import { signTransaction, type EncryptedWallet, type KmsAdapter } from '../custody/index.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/** The sole bridge into custody. It returns a signed transaction, never a
 * signer, secret, or decrypted data key. */
export function createPrismaCustodySigner(prisma: PrismaClient, kms: KmsAdapter) {
  return async (
    projectWalletId: string,
    transaction: Transaction | VersionedTransaction,
  ): Promise<Transaction | VersionedTransaction> => {
    const row = await prisma.projectWallet.findUniqueOrThrow({
      where: { id: projectWalletId },
      select: {
        publicKey: true,
        keyCiphertext: true,
        encryptedDataKey: true,
        kmsKeyId: true,
      },
    });
    const wallet: EncryptedWallet = {
      publicKey: row.publicKey,
      keyCiphertext: Uint8Array.from(row.keyCiphertext),
      encryptedDataKey: Uint8Array.from(row.encryptedDataKey),
      kmsKeyId: row.kmsKeyId,
    };
    return signTransaction(kms, wallet, transaction, 'devnet');
  };
}

