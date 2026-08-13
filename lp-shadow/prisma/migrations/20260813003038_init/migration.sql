-- CreateTable
CREATE TABLE "Snapshot" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeBinId" INTEGER NOT NULL,
    "activePrice" DECIMAL(38,18) NOT NULL,
    "jupPrice" DECIMAL(38,18),
    "binStepBps" INTEGER NOT NULL,
    "feeBps" DECIMAL(18,6) NOT NULL,
    "liqActiveBin" DECIMAL(38,18) NOT NULL,
    "liqNearbyJson" JSONB NOT NULL,
    "poolTvlUsd" DECIMAL(38,18),
    "poolVol24hUsd" DECIMAL(38,18),
    "poolFees24hUsd" DECIMAL(38,18),
    "poolFeesIntervalUsd" DECIMAL(38,18),
    "volFast" DECIMAL(18,8),
    "volSlow" DECIMAL(18,8),
    "costInputsJson" JSONB,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" BIGSERIAL NOT NULL,
    "snapshotId" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "reasonsJson" JSONB NOT NULL,
    "costEstJson" JSONB,
    "newLowerBin" INTEGER,
    "newUpperBin" INTEGER,
    "applied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VirtualPositionEvent" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "lowerBinId" INTEGER,
    "upperBinId" INTEGER,
    "baseAmount" DECIMAL(38,18) NOT NULL,
    "quoteAmount" DECIMAL(38,18) NOT NULL,
    "feesAccruedQ" DECIMAL(38,18) NOT NULL,
    "costsPaidQ" DECIMAL(38,18) NOT NULL,
    "navUsd" DECIMAL(38,18) NOT NULL,
    "detailJson" JSONB,

    CONSTRAINT "VirtualPositionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkMark" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hodlNavUsd" DECIMAL(38,18) NOT NULL,
    "fullRangeUsd" DECIMAL(38,18) NOT NULL,
    "strategyUsd" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "BenchmarkMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyValue" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyValue_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ReplayRun" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT NOT NULL,
    "fromTs" TIMESTAMP(3) NOT NULL,
    "toTs" TIMESTAMP(3) NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "resultsJson" JSONB NOT NULL,

    CONSTRAINT "ReplayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayEvent" (
    "id" BIGSERIAL NOT NULL,
    "runId" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "snapshotId" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "reasonsJson" JSONB NOT NULL,
    "navUsd" DECIMAL(38,18) NOT NULL,
    "hodlUsd" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "ReplayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Snapshot_ts_idx" ON "Snapshot"("ts");

-- CreateIndex
CREATE INDEX "Decision_ts_idx" ON "Decision"("ts");

-- CreateIndex
CREATE INDEX "Decision_kind_ts_idx" ON "Decision"("kind", "ts");

-- CreateIndex
CREATE INDEX "Decision_snapshotId_idx" ON "Decision"("snapshotId");

-- CreateIndex
CREATE INDEX "VirtualPositionEvent_ts_idx" ON "VirtualPositionEvent"("ts");

-- CreateIndex
CREATE INDEX "VirtualPositionEvent_kind_ts_idx" ON "VirtualPositionEvent"("kind", "ts");

-- CreateIndex
CREATE INDEX "BenchmarkMark_ts_idx" ON "BenchmarkMark"("ts");

-- CreateIndex
CREATE INDEX "ReplayRun_ts_idx" ON "ReplayRun"("ts");

-- CreateIndex
CREATE INDEX "ReplayEvent_runId_ts_idx" ON "ReplayEvent"("runId", "ts");

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplayEvent" ADD CONSTRAINT "ReplayEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReplayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
