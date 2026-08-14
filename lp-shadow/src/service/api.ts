/**
 * The service factory: wires config + Prisma into the LpShadowService object
 * the bot layer consumes. This file is glue; the behavior lives in the sibling
 * modules and, beneath them, in the same registry/report/replay code the loop
 * and the CLIs use — the bot is just another caller.
 */
import 'dotenv/config';
import { loadEnv, loadRawConfig, toExecutionConfig, toParams } from '../config.js';
import { disconnectPrisma, getPrisma } from '../ledger/prisma.js';
import { publishStrategyVersion } from '../ledger/registry.js';
import { BINS_PER_CLASSIC_POSITION } from '../poller/sdkConstants.js';
import { ServiceError } from './errors.js';
import { getTenantByChatId, redeemHandoff } from './handoff.js';
import {
  addPool,
  listPoolRows,
  previewPool,
  resolvePoolRow,
  summarize,
  transitionMode,
} from './pools.js';
import { runReplayForPool } from './replay.js';
import { getStatus, getStrategy, getVerdict, getWhy, type GoLiveCache } from './reports.js';
import type { LpShadowService, PoolSummary } from './types.js';
import { requestFullWithdrawal } from './withdrawals.js';
import { planInitialLiquidityForLaunch } from './launchPlanning.js';

export async function createService(): Promise<LpShadowService> {
  const env = loadEnv();
  const rawConfig = loadRawConfig();
  const configParams = toParams(rawConfig, BINS_PER_CLASSIC_POSITION);
  const executionConfig = toExecutionConfig(rawConfig);
  const prisma = getPrisma(env.DATABASE_URL);

  // Same seed the loop performs on boot; a no-op when the version exists. The
  // bot may be the first process ever pointed at a fresh database.
  await publishStrategyVersion(prisma, configParams, 'seeded from config/default.toml');

  const goLiveCache: GoLiveCache = new Map();

  const latestStrategy = async (): Promise<{ id: string }> => {
    const latest = await prisma.strategyVersion.findFirst({
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    // Seeded three lines up; absence means the DB vanished mid-flight.
    if (!latest) throw new ServiceError('INVALID_INPUT', 'No strategy is published yet.');
    return latest;
  };

  return {
    redeemHandoff: (token, telegramChatId) => redeemHandoff(prisma, token, telegramChatId),
    getTenantByChatId: (telegramChatId) => getTenantByChatId(prisma, telegramChatId),

    previewPool: (poolAddress) => previewPool(poolAddress),
    addPool: async (tenantId, input) => addPool(prisma, await latestStrategy(), tenantId, input),
    listPools: async (tenantId): Promise<PoolSummary[]> => {
      const rows = await listPoolRows(prisma, tenantId);
      return Promise.all(rows.map((row) => summarize(prisma, row)));
    },

    getStatus: async (tenantId, poolRef) =>
      getStatus(prisma, configParams, await resolvePoolRow(prisma, tenantId, poolRef), goLiveCache),
    getWhy: async (tenantId, poolRef) =>
      getWhy(prisma, await resolvePoolRow(prisma, tenantId, poolRef)),
    getVerdict: async (tenantId, poolRef) =>
      getVerdict(prisma, configParams, await resolvePoolRow(prisma, tenantId, poolRef), goLiveCache),
    runReplay: async (tenantId, poolRef, opts) =>
      runReplayForPool(
        prisma,
        await resolvePoolRow(prisma, tenantId, poolRef),
        configParams,
        opts,
      ),
    getStrategy: () => getStrategy(prisma),
    planInitialLiquidity: async (input) =>
      planInitialLiquidityForLaunch(input, executionConfig.caps),

    pausePool: async (tenantId, poolRef) =>
      transitionMode(prisma, await resolvePoolRow(prisma, tenantId, poolRef), 'pause'),
    resumePool: async (tenantId, poolRef) =>
      transitionMode(prisma, await resolvePoolRow(prisma, tenantId, poolRef), 'resume'),
    removePool: async (tenantId, poolRef) =>
      transitionMode(prisma, await resolvePoolRow(prisma, tenantId, poolRef), 'remove'),
    requestWithdrawal: (tenantId) => requestFullWithdrawal(prisma, tenantId),

    getBotToken: () => env.TELEGRAM_BOT_TOKEN,
    close: () => disconnectPrisma(),
  };
}
