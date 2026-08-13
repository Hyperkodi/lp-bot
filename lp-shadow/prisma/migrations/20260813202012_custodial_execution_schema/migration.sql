-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "strategyProfileVersionId" TEXT NOT NULL DEFAULT 'legacy-shadow-profile-v1';

-- AlterTable
ALTER TABLE "ManagedPool" ADD COLUMN     "strategyProfileVersionId" TEXT NOT NULL DEFAULT 'legacy-shadow-profile-v1';

-- CreateTable
CREATE TABLE "StrategyProfile" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyProfileVersion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "distributionShape" TEXT NOT NULL,
    "defaultBinStepBps" INTEGER NOT NULL,
    "launchGuardHours" INTEGER NOT NULL DEFAULT 24,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyProfileVersion_pkey" PRIMARY KEY ("id")
);

-- Historical Phase 1 rows used the single canonical StrategyVersion model.
-- Give them an explicit profile stamp before the foreign keys are installed;
-- the original StrategyVersion relation remains the precise parameter record.
INSERT INTO "StrategyProfile" ("id", "slug", "name", "description")
VALUES (
    'legacy-shadow-profile',
    'legacy-shadow',
    'Legacy Shadow',
    'Compatibility profile for decisions recorded before founder-selectable profiles existed.'
);

INSERT INTO "StrategyProfileVersion" (
    "id", "profileId", "version", "paramsJson", "distributionShape",
    "defaultBinStepBps", "launchGuardHours", "note"
)
VALUES (
    'legacy-shadow-profile-v1',
    'legacy-shadow-profile',
    1,
    '{}'::jsonb,
    'SPOT',
    25,
    24,
    'Migration stamp for the retained Phase 1 shadow engine.'
);

-- CreateTable
CREATE TABLE "ProjectWallet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "withdrawalAddress" TEXT NOT NULL,
    "keyCiphertext" BYTEA NOT NULL,
    "encryptedDataKey" BYTEA NOT NULL,
    "kmsKeyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_DEPOSIT',
    "gasReserveLamports" BIGINT NOT NULL DEFAULT 50000000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositEvent" (
    "id" BIGSERIAL NOT NULL,
    "projectWalletId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "assetMint" TEXT,
    "amount" DECIMAL(38,18) NOT NULL,
    "kind" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detailJson" JSONB,

    CONSTRAINT "DepositEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionIntent" (
    "id" TEXT NOT NULL,
    "projectWalletId" TEXT NOT NULL,
    "managedPoolId" TEXT,
    "decisionId" BIGINT,
    "idempotencyKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "notionalSol" DECIMAL(38,18) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "detailJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionOutcome" (
    "id" BIGSERIAL NOT NULL,
    "intentId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "signature" TEXT,
    "chainStateJson" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutionOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeCharge" (
    "id" BIGSERIAL NOT NULL,
    "projectWalletId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "assetMint" TEXT,
    "earnedAmount" DECIMAL(38,18) NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "chargedAmount" DECIMAL(38,18) NOT NULL,
    "treasuryDestination" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "projectWalletId" TEXT NOT NULL,
    "withdrawalAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "intentId" TEXT,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressChangeRequest" (
    "id" TEXT NOT NULL,
    "projectWalletId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "effectiveAfter" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "AddressChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StrategyProfile_slug_key" ON "StrategyProfile"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyProfile_name_key" ON "StrategyProfile"("name");

-- CreateIndex
CREATE INDEX "StrategyProfileVersion_profileId_idx" ON "StrategyProfileVersion"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyProfileVersion_profileId_version_key" ON "StrategyProfileVersion"("profileId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectWallet_tenantId_key" ON "ProjectWallet"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectWallet_publicKey_key" ON "ProjectWallet"("publicKey");

-- CreateIndex
CREATE INDEX "ProjectWallet_status_idx" ON "ProjectWallet"("status");

-- CreateIndex
CREATE INDEX "DepositEvent_projectWalletId_observedAt_idx" ON "DepositEvent"("projectWalletId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepositEvent_signature_eventIndex_key" ON "DepositEvent"("signature", "eventIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key" ON "ExecutionIntent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExecutionIntent_projectWalletId_createdAt_idx" ON "ExecutionIntent"("projectWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionIntent_managedPoolId_createdAt_idx" ON "ExecutionIntent"("managedPoolId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionIntent_decisionId_idx" ON "ExecutionIntent"("decisionId");

-- CreateIndex
CREATE INDEX "ExecutionIntent_status_createdAt_idx" ON "ExecutionIntent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionOutcome_status_createdAt_idx" ON "ExecutionOutcome"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionOutcome_signature_idx" ON "ExecutionOutcome"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionOutcome_intentId_attempt_key" ON "ExecutionOutcome"("intentId", "attempt");

-- CreateIndex
CREATE INDEX "FeeCharge_projectWalletId_createdAt_idx" ON "FeeCharge"("projectWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "FeeCharge_intentId_idx" ON "FeeCharge"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_intentId_key" ON "WithdrawalRequest"("intentId");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_projectWalletId_requestedAt_idx" ON "WithdrawalRequest"("projectWalletId", "requestedAt");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_requestedAt_idx" ON "WithdrawalRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "AddressChangeRequest_projectWalletId_requestedAt_idx" ON "AddressChangeRequest"("projectWalletId", "requestedAt");

-- CreateIndex
CREATE INDEX "AddressChangeRequest_status_effectiveAfter_idx" ON "AddressChangeRequest"("status", "effectiveAfter");

-- CreateIndex
CREATE INDEX "Decision_strategyProfileVersionId_idx" ON "Decision"("strategyProfileVersionId");

-- CreateIndex
CREATE INDEX "ManagedPool_strategyProfileVersionId_idx" ON "ManagedPool"("strategyProfileVersionId");

-- AddForeignKey
ALTER TABLE "StrategyProfileVersion" ADD CONSTRAINT "StrategyProfileVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StrategyProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedPool" ADD CONSTRAINT "ManagedPool_strategyProfileVersionId_fkey" FOREIGN KEY ("strategyProfileVersionId") REFERENCES "StrategyProfileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_strategyProfileVersionId_fkey" FOREIGN KEY ("strategyProfileVersionId") REFERENCES "StrategyProfileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectWallet" ADD CONSTRAINT "ProjectWallet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositEvent" ADD CONSTRAINT "DepositEvent_projectWalletId_fkey" FOREIGN KEY ("projectWalletId") REFERENCES "ProjectWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_projectWalletId_fkey" FOREIGN KEY ("projectWalletId") REFERENCES "ProjectWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_managedPoolId_fkey" FOREIGN KEY ("managedPoolId") REFERENCES "ManagedPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionOutcome" ADD CONSTRAINT "ExecutionOutcome_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCharge" ADD CONSTRAINT "FeeCharge_projectWalletId_fkey" FOREIGN KEY ("projectWalletId") REFERENCES "ProjectWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCharge" ADD CONSTRAINT "FeeCharge_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_projectWalletId_fkey" FOREIGN KEY ("projectWalletId") REFERENCES "ProjectWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddressChangeRequest" ADD CONSTRAINT "AddressChangeRequest_projectWalletId_fkey" FOREIGN KEY ("projectWalletId") REFERENCES "ProjectWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
