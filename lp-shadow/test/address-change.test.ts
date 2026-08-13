import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import {
  applyAddressChange,
  confirmAddressChange,
  requestAddressChange,
} from '../src/service/addressChanges.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('withdrawal address changes', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');
  let tenantId: string;

  async function truncateTouchedTables() {
    await prisma.addressChangeRequest.deleteMany({});
    await prisma.projectWallet.deleteMany({});
    await prisma.tenant.deleteMany({});
  }

  beforeAll(async () => {
    await truncateTouchedTables();
    const tenant = await prisma.tenant.create({
      data: { externalUserId: 'address-user', telegramChatId: 'address-chat', label: 'Address' },
    });
    tenantId = tenant.id;
    await prisma.projectWallet.create({
      data: {
        tenantId,
        publicKey: 'ADDRESS_WALLET',
        withdrawalAddress: 'OLD_ADDRESS',
        keyCiphertext: Uint8Array.of(1),
        encryptedDataKey: Uint8Array.of(2),
        kmsKeyId: 'test-only',
      },
    });
  });

  afterAll(async () => {
    await truncateTouchedTables();
    await disconnectPrisma();
  });

  it('requires confirmation and a full 24-hour delay', async () => {
    const requestedAt = new Date('2026-08-13T00:00:00Z');
    const request = await requestAddressChange(prisma, tenantId, 'NEW_ADDRESS', requestedAt);
    expect(request.effectiveAfter.toISOString()).toBe('2026-08-14T00:00:00.000Z');

    await expect(
      applyAddressChange(prisma, request.id, new Date('2026-08-14T00:00:00Z')),
    ).rejects.toThrow(/not confirmed/i);
    await confirmAddressChange(prisma, request.id, new Date('2026-08-13T00:05:00Z'));
    await expect(
      applyAddressChange(prisma, request.id, new Date('2026-08-13T23:59:59Z')),
    ).rejects.toThrow(/24-hour/i);
    await applyAddressChange(prisma, request.id, new Date('2026-08-14T00:00:00Z'));
    expect(
      (await prisma.projectWallet.findUniqueOrThrow({ where: { tenantId } })).withdrawalAddress,
    ).toBe('NEW_ADDRESS');
  });
});
