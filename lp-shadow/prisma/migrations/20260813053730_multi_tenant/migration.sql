/*
  Warnings:

  - The primary key for the `KeyValue` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `managedPoolId` to the `BenchmarkMark` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managedPoolId` to the `Decision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `strategyVersionId` to the `Decision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `scope` to the `KeyValue` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managedPoolId` to the `ReplayRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managedPoolId` to the `Snapshot` table without a default value. This is not possible if the table is not empty.
  - Added the required column `managedPoolId` to the `VirtualPositionEvent` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "BenchmarkMark_ts_idx";

-- DropIndex
DROP INDEX "Decision_kind_ts_idx";

-- DropIndex
DROP INDEX "Decision_ts_idx";

-- DropIndex
DROP INDEX "ReplayRun_ts_idx";

-- DropIndex
DROP INDEX "Snapshot_ts_idx";

-- DropIndex
DROP INDEX "VirtualPositionEvent_kind_ts_idx";

-- DropIndex
DROP INDEX "VirtualPositionEvent_ts_idx";

-- AlterTable
ALTER TABLE "BenchmarkMark" ADD COLUMN     "managedPoolId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "managedPoolId" TEXT NOT NULL,
ADD COLUMN     "strategyVersionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "KeyValue" DROP CONSTRAINT "KeyValue_pkey",
ADD COLUMN     "scope" TEXT NOT NULL,
ADD CONSTRAINT "KeyValue_pkey" PRIMARY KEY ("scope", "key");

-- AlterTable
ALTER TABLE "ReplayRun" ADD COLUMN     "managedPoolId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Snapshot" ADD COLUMN     "managedPoolId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "VirtualPositionEvent" ADD COLUMN     "managedPoolId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedPool" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "virtualNavUsd" DECIMAL(38,18) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PRIMARY',
    "mode" TEXT NOT NULL DEFAULT 'SHADOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "ManagedPool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_externalUserId_key" ON "Tenant"("externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_telegramChatId_key" ON "Tenant"("telegramChatId");

-- CreateIndex
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_version_key" ON "StrategyVersion"("version");

-- CreateIndex
CREATE INDEX "ManagedPool_mode_idx" ON "ManagedPool"("mode");

-- CreateIndex
CREATE INDEX "ManagedPool_tenantId_idx" ON "ManagedPool"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedPool_tenantId_poolAddress_role_key" ON "ManagedPool"("tenantId", "poolAddress", "role");

-- CreateIndex
CREATE INDEX "BenchmarkMark_managedPoolId_ts_idx" ON "BenchmarkMark"("managedPoolId", "ts");

-- CreateIndex
CREATE INDEX "Decision_managedPoolId_ts_idx" ON "Decision"("managedPoolId", "ts");

-- CreateIndex
CREATE INDEX "Decision_managedPoolId_kind_ts_idx" ON "Decision"("managedPoolId", "kind", "ts");

-- CreateIndex
CREATE INDEX "Decision_strategyVersionId_idx" ON "Decision"("strategyVersionId");

-- CreateIndex
CREATE INDEX "ReplayRun_managedPoolId_ts_idx" ON "ReplayRun"("managedPoolId", "ts");

-- CreateIndex
CREATE INDEX "Snapshot_managedPoolId_ts_idx" ON "Snapshot"("managedPoolId", "ts");

-- CreateIndex
CREATE INDEX "VirtualPositionEvent_managedPoolId_ts_idx" ON "VirtualPositionEvent"("managedPoolId", "ts");

-- CreateIndex
CREATE INDEX "VirtualPositionEvent_managedPoolId_kind_ts_idx" ON "VirtualPositionEvent"("managedPoolId", "kind", "ts");

-- AddForeignKey
ALTER TABLE "ManagedPool" ADD CONSTRAINT "ManagedPool_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedPool" ADD CONSTRAINT "ManagedPool_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_managedPoolId_fkey" FOREIGN KEY ("managedPoolId") REFERENCES "ManagedPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_managedPoolId_fkey" FOREIGN KEY ("managedPoolId") REFERENCES "ManagedPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VirtualPositionEvent" ADD CONSTRAINT "VirtualPositionEvent_managedPoolId_fkey" FOREIGN KEY ("managedPoolId") REFERENCES "ManagedPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkMark" ADD CONSTRAINT "BenchmarkMark_managedPoolId_fkey" FOREIGN KEY ("managedPoolId") REFERENCES "ManagedPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplayRun" ADD CONSTRAINT "ReplayRun_managedPoolId_fkey" FOREIGN KEY ("managedPoolId") REFERENCES "ManagedPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
