import type { PrismaClient } from '../generated/prisma/client.js';
import { ServiceError } from './errors.js';
import type { WithdrawalReceipt } from './types.js';

/** Record a full withdrawal independently of pool mode and the signing kill
 * switch. A worker closes, settles earned-fee charges, and sweeps later; the
 * founder's request itself is never strategy-gated or cooling-period delayed. */
export async function requestFullWithdrawal(
  prisma: PrismaClient,
  tenantId: string,
): Promise<WithdrawalReceipt> {
  const wallet = await prisma.projectWallet.findUnique({
    where: { tenantId },
    select: { id: true, withdrawalAddress: true },
  });
  if (!wallet) {
    throw new ServiceError('INVALID_INPUT', 'No custodial project wallet is registered yet.');
  }
  const existing = await prisma.withdrawalRequest.findFirst({
    where: { projectWalletId: wallet.id, status: { in: ['REQUESTED', 'PROCESSING'] } },
    orderBy: { requestedAt: 'desc' },
  });
  const row =
    existing ??
    (await prisma.withdrawalRequest.create({
      data: {
        projectWalletId: wallet.id,
        withdrawalAddress: wallet.withdrawalAddress,
        status: 'REQUESTED',
      },
    }));
  return {
    requestId: row.id,
    status: 'REQUESTED',
    withdrawalAddress: row.withdrawalAddress,
    requestedAt: row.requestedAt.toISOString(),
  };
}
