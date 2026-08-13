import type { PrismaClient } from '../generated/prisma/client.js';
import { ServiceError } from './errors.js';

const ADDRESS_CHANGE_DELAY_MS = 24 * 60 * 60 * 1_000;

export async function requestAddressChange(
  prisma: PrismaClient,
  tenantId: string,
  toAddress: string,
  now = new Date(),
) {
  if (!toAddress.trim()) throw new ServiceError('INVALID_INPUT', 'New withdrawal address is required.');
  const wallet = await prisma.projectWallet.findUnique({ where: { tenantId } });
  if (!wallet) throw new ServiceError('INVALID_INPUT', 'No custodial project wallet is registered yet.');
  if (wallet.withdrawalAddress === toAddress) {
    throw new ServiceError('INVALID_INPUT', 'That is already the registered withdrawal address.');
  }
  return prisma.addressChangeRequest.create({
    data: {
      projectWalletId: wallet.id,
      fromAddress: wallet.withdrawalAddress,
      toAddress,
      status: 'PENDING_CONFIRMATION',
      effectiveAfter: new Date(now.getTime() + ADDRESS_CHANGE_DELAY_MS),
    },
  });
}

export async function confirmAddressChange(
  prisma: PrismaClient,
  requestId: string,
  now = new Date(),
) {
  return prisma.addressChangeRequest.update({
    where: { id: requestId },
    data: { status: 'PENDING_DELAY', confirmedAt: now },
  });
}

export async function applyAddressChange(
  prisma: PrismaClient,
  requestId: string,
  now = new Date(),
) {
  return prisma.$transaction(async (transaction) => {
    const request = await transaction.addressChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== 'PENDING_DELAY' || !request.confirmedAt) {
      throw new ServiceError('INVALID_INPUT', 'The address change is not confirmed.');
    }
    if (now < request.effectiveAfter) {
      throw new ServiceError('INVALID_INPUT', 'The 24-hour address-change delay has not elapsed.');
    }
    await transaction.projectWallet.update({
      where: { id: request.projectWalletId },
      data: { withdrawalAddress: request.toAddress },
    });
    return transaction.addressChangeRequest.update({
      where: { id: request.id },
      data: { status: 'APPLIED', appliedAt: now },
    });
  });
}
