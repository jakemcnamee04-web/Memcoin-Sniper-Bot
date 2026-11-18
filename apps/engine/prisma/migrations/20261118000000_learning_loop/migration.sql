-- CreateTable
CREATE TABLE "TrackedCoin" (
    "id" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "decision" "Decision" NOT NULL,
    "initialLiquidityUsd" DOUBLE PRECISION NOT NULL,
    "results" JSONB NOT NULL,
    "evalThresholds" JSONB NOT NULL,
    "path" JSONB NOT NULL,
    "timeScale" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "endReason" TEXT,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedCoin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentName" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "isChampion" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TunerRun" (
    "id" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "promoted" TEXT,
    "report" JSONB NOT NULL,

    CONSTRAINT "TunerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedCoin_poolAddress_key" ON "TrackedCoin"("poolAddress");

-- CreateIndex
CREATE INDEX "TrackedCoin_decidedAt_idx" ON "TrackedCoin"("decidedAt");

-- CreateIndex
CREATE INDEX "TrackedCoin_status_idx" ON "TrackedCoin"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_name_key" ON "StrategyVersion"("name");

-- CreateIndex
CREATE INDEX "StrategyVersion_retiredAt_idx" ON "StrategyVersion"("retiredAt");

-- CreateIndex
CREATE INDEX "StrategyVersion_isChampion_idx" ON "StrategyVersion"("isChampion");

-- CreateIndex
CREATE INDEX "TunerRun_ranAt_idx" ON "TunerRun"("ranAt");
