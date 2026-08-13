-- A STOPPED pool row permanently blocked re-adding the same pool: the
-- uniqueness key had no run discriminator, so the retained history row
-- collided with any fresh /add. runSeq stays 0 for live rows (preserving
-- one-live-run-per-pool+role) and is stamped with the stop time when a run
-- ends, freeing the key for the next run.

-- AlterTable
ALTER TABLE "ManagedPool" ADD COLUMN "runSeq" BIGINT NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX "ManagedPool_tenantId_poolAddress_role_key";

-- CreateIndex
CREATE UNIQUE INDEX "ManagedPool_tenantId_poolAddress_role_runSeq_key" ON "ManagedPool"("tenantId", "poolAddress", "role", "runSeq");
