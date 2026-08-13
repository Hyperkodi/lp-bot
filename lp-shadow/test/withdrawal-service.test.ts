import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import { requestFullWithdrawal } from '../src/service/withdrawals.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('withdrawal service', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');
  let tenantId: string;

  async function truncateTouchedTables() {
    await prisma.withdrawalRequest.deleteMany({});
    await prisma.projectWallet.deleteMany({});
    await prisma.keyValue.deleteMany({});
    await prisma.tenant.deleteMany({});
  }

  beforeAll(async () => {
    await truncateTouchedTables();
    const tenant = await prisma.tenant.create({
      data: { externalUserId: 'withdraw-user', telegramChatId: 'withdraw-chat', label: 'Withdraw' },
    });
    tenantId = tenant.id;
    await prisma.projectWallet.create({
      data: {
        tenantId,
        publicKey: 'WITHDRAW_WALLET',
        withdrawalAddress: 'CURRENT_REGISTERED_ADDRESS',
        keyCiphertext: Uint8Array.of(1),
        encryptedDataKey: Uint8Array.of(2),
        kmsKeyId: 'test-only',
        status: 'POSITION_OPEN',
      },
    });
    await prisma.keyValue.create({
      data: { scope: 'global', key: 'execution.kill_switch', value: { enabled: true } },
    });
  });

  afterAll(async () => {
    await truncateTouchedTables();
    await disconnectPrisma();
  });

  it('records immediately despite the execution kill switch and is idempotent', async () => {
    const first = await requestFullWithdrawal(prisma, tenantId);
    const second = await requestFullWithdrawal(prisma, tenantId);

    expect(first.status).toBe('REQUESTED');
    expect(first.withdrawalAddress).toBe('CURRENT_REGISTERED_ADDRESS');
    expect(second.requestId).toBe(first.requestId);
    expect(await prisma.withdrawalRequest.count()).toBe(1);
  });
});
