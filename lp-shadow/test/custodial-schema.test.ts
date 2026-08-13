import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('custodial ledger schema', () => {
  const prisma = getPrisma(process.env.DATABASE_URL ?? '');

  async function truncateTouchedTables() {
    await prisma.executionOutcome.deleteMany({});
    await prisma.feeCharge.deleteMany({});
    await prisma.withdrawalRequest.deleteMany({});
    await prisma.addressChangeRequest.deleteMany({});
    await prisma.executionIntent.deleteMany({});
    await prisma.depositEvent.deleteMany({});
    await prisma.projectWallet.deleteMany({});
    await prisma.decision.deleteMany({});
    await prisma.snapshot.deleteMany({});
    await prisma.virtualPositionEvent.deleteMany({});
    await prisma.benchmarkMark.deleteMany({});
    await prisma.replayEvent.deleteMany({});
    await prisma.replayRun.deleteMany({});
    await prisma.managedPool.deleteMany({});
    await prisma.strategyProfileVersion.deleteMany({});
    await prisma.strategyProfile.deleteMany({});
    await prisma.strategyVersion.deleteMany({});
    await prisma.tenant.deleteMany({});
  }

  beforeAll(async () => {
    await truncateTouchedTables();
  });

  afterAll(async () => {
    await truncateTouchedTables();
    await disconnectPrisma();
  });

  it('stores versioned profiles and stamps pools and decisions with one', async () => {
    const profile = await prisma.strategyProfile.create({
      data: { slug: 'fee-maximizer', name: 'Fee Maximizer', description: 'Narrow and aggressive.' },
    });
    const version = await prisma.strategyProfileVersion.create({
      data: {
        profileId: profile.id,
        version: 1,
        paramsJson: { widthK: 0.8 },
        distributionShape: 'SPOT',
        defaultBinStepBps: 10,
        launchGuardHours: 24,
        note: 'initial',
      },
    });
    const tenant = await prisma.tenant.create({
      data: { externalUserId: 'schema-user', telegramChatId: 'schema-chat', label: 'Schema' },
    });
    const legacyVersion = await prisma.strategyVersion.create({
      data: { version: 1, paramsJson: {}, note: 'legacy compatibility' },
    });
    const pool = await prisma.managedPool.create({
      data: {
        tenantId: tenant.id,
        strategyVersionId: legacyVersion.id,
        strategyProfileVersionId: version.id,
        poolAddress: 'SCHEMA_POOL',
        label: 'Schema pool',
        virtualNavUsd: 1_000,
      },
    });
    const snapshot = await prisma.snapshot.create({
      data: {
        managedPoolId: pool.id,
        activeBinId: 0,
        activePrice: 1,
        binStepBps: 10,
        feeBps: 30,
        liqActiveBin: 1,
        liqNearbyJson: [],
      },
    });
    const decision = await prisma.decision.create({
      data: {
        managedPoolId: pool.id,
        snapshotId: snapshot.id,
        strategyVersionId: legacyVersion.id,
        strategyProfileVersionId: version.id,
        kind: 'HOLD',
        reasonsJson: ['launch guard'],
      },
    });

    expect(decision.strategyProfileVersionId).toBe(version.id);
    await expect(
      prisma.strategyProfileVersion.create({
        data: {
          profileId: profile.id,
          version: 1,
          paramsJson: {},
          distributionShape: 'SPOT',
          defaultBinStepBps: 10,
          note: 'duplicate',
        },
      }),
    ).rejects.toThrow();
  });

  it('stores ciphertext and the append-only custody and execution records', async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { externalUserId: 'schema-user' } });
    const wallet = await prisma.projectWallet.create({
      data: {
        tenantId: tenant.id,
        publicKey: 'SCHEMA_WALLET',
        withdrawalAddress: 'SCHEMA_WITHDRAWAL',
        keyCiphertext: Uint8Array.from([1, 2, 3]),
        encryptedDataKey: Uint8Array.from([4, 5, 6]),
        kmsKeyId: 'local-dev',
      },
    });
    const deposit = await prisma.depositEvent.create({
      data: {
        projectWalletId: wallet.id,
        signature: 'deposit-signature',
        eventIndex: 0,
        assetMint: null,
        amount: 2,
        kind: 'DEPOSIT',
      },
    });
    const intent = await prisma.executionIntent.create({
      data: {
        projectWalletId: wallet.id,
        idempotencyKey: 'schema-intent',
        action: 'COMPOUND',
        notionalSol: 0.25,
        status: 'RECORDED',
      },
    });
    const outcome = await prisma.executionOutcome.create({
      data: { intentId: intent.id, attempt: 1, status: 'FINALIZED', signature: 'tx-signature' },
    });
    const fee = await prisma.feeCharge.create({
      data: {
        projectWalletId: wallet.id,
        intentId: intent.id,
        assetMint: null,
        earnedAmount: 0.1,
        rateBps: 1_000,
        chargedAmount: 0.01,
        treasuryDestination: 'ARMARA_TREASURY',
      },
    });
    const withdrawal = await prisma.withdrawalRequest.create({
      data: {
        projectWalletId: wallet.id,
        withdrawalAddress: wallet.withdrawalAddress,
        status: 'REQUESTED',
      },
    });
    const addressChange = await prisma.addressChangeRequest.create({
      data: {
        projectWalletId: wallet.id,
        fromAddress: wallet.withdrawalAddress,
        toAddress: 'NEW_WITHDRAWAL',
        status: 'PENDING_DELAY',
        effectiveAfter: new Date(Date.now() + 86_400_000),
      },
    });

    expect(Object.keys(wallet)).not.toContain('secretKey');
    expect(deposit.projectWalletId).toBe(wallet.id);
    expect(outcome.intentId).toBe(intent.id);
    expect(fee.chargedAmount.toString()).toBe('0.01');
    expect(withdrawal.withdrawalAddress).toBe('SCHEMA_WITHDRAWAL');
    expect(addressChange.effectiveAfter.getTime()).toBeGreaterThan(Date.now());
  });
});
