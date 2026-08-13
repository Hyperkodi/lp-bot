import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaExecutionStore } from '../src/execution/prismaStore.js';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import type { ExecutionRequest } from '../src/execution/index.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('Postgres execution store', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');
  const store = new PrismaExecutionStore(prisma);
  let projectWalletId: string;

  async function truncateTouchedTables() {
    await prisma.executionOutcome.deleteMany({});
    await prisma.feeCharge.deleteMany({});
    await prisma.withdrawalRequest.deleteMany({});
    await prisma.addressChangeRequest.deleteMany({});
    await prisma.executionIntent.deleteMany({});
    await prisma.depositEvent.deleteMany({});
    await prisma.projectWallet.deleteMany({});
    await prisma.keyValue.deleteMany({});
    await prisma.tenant.deleteMany({});
  }

  beforeAll(async () => {
    await truncateTouchedTables();
    const tenant = await prisma.tenant.create({
      data: { externalUserId: 'execution-store-user', telegramChatId: 'execution-store-chat', label: 'Executor' },
    });
    const wallet = await prisma.projectWallet.create({
      data: {
        tenantId: tenant.id,
        publicKey: 'EXECUTION_STORE_WALLET',
        withdrawalAddress: 'EXECUTION_STORE_WITHDRAWAL',
        keyCiphertext: Uint8Array.of(1),
        encryptedDataKey: Uint8Array.of(2),
        kmsKeyId: 'test-only',
      },
    });
    projectWalletId = wallet.id;
  });

  afterAll(async () => {
    await truncateTouchedTables();
    await disconnectPrisma();
  });

  const request = (): ExecutionRequest => ({
    projectWalletId,
    idempotencyKey: 'store-intent-1',
    action: 'COMPOUND',
    notionalSol: 3,
    destinations: {
      projectWalletAddress: 'wallet',
      founderWithdrawalAddress: 'founder',
      founderTokenAccounts: new Set(),
      feeTreasuryAddress: 'treasury',
      feeTreasuryTokenAccounts: new Set(),
      poolProgramAccounts: new Set(),
    },
  });

  it('reads the database kill switch without relying on deploy state', async () => {
    expect(await store.isKillSwitchEnabled()).toBe(false);
    await prisma.keyValue.create({
      data: { scope: 'global', key: 'execution.kill_switch', value: { enabled: true } },
    });
    expect(await store.isKillSwitchEnabled()).toBe(true);
    await prisma.keyValue.delete({ where: { scope_key: { scope: 'global', key: 'execution.kill_switch' } } });
  });

  it('persists intent before outcomes and counts only sent notional', async () => {
    const intent = await store.createIntent(request());
    expect(await store.findIntent('store-intent-1')).toMatchObject({ id: intent.id, status: 'RECORDED' });
    expect(await store.rollingNotionalSol(projectWalletId, new Date(0))).toEqual({
      projectSol: 0,
      globalSol: 0,
    });

    await store.updateIntent(intent.id, 'SENT');
    expect(await store.rollingNotionalSol(projectWalletId, new Date(0))).toEqual({
      projectSol: 3,
      globalSol: 3,
    });
    const outcome = await store.createOutcome(intent.id, 1, 'SENT', 'store-signature');
    await store.updateOutcome(outcome.id, 'FINALIZED', {
      chainState: { applied: true },
      finalizedAt: new Date(),
    });
    expect(await store.countOutcomes(intent.id)).toBe(1);
  });

  it('refuses a second concurrent executor for the same project', async () => {
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const hold = new Promise<void>((resolve) => (release = resolve));
    const first = store.withProjectLock(projectWalletId, async () => {
      entered();
      await hold;
      return 'first';
    });
    await inside;
    await expect(store.withProjectLock(projectWalletId, async () => 'second')).rejects.toThrow(
      /lock contention/i,
    );
    release();
    await expect(first).resolves.toBe('first');
  });
});
