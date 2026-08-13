/**
 * `pnpm report` — build and send the daily report on demand, outside the 07:00
 * schedule. Useful for checking formatting without waiting a day.
 *
 *   pnpm report                    # every shadowed pool
 *   pnpm report --pool <id>        # one pool
 *   pnpm report --print-only       # print only
 *   pnpm report --go-live          # force the weekly go-live block
 */
import 'dotenv/config';
import { loadEnv, loadRawConfig, paramsForPool, toParams } from '../config.js';
import { disconnectPrisma, getPrisma } from '../ledger/prisma.js';
import { listActivePools } from '../ledger/registry.js';
import { errorMessage, log } from '../logger.js';
import { BINS_PER_CLASSIC_POSITION } from '../poller/sdkConstants.js';
import { isWeeklyReportDay } from '../clock.js';
import { buildDailyReport } from './daily.js';
import { createTelegram } from './telegram.js';

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const configParams = toParams(loadRawConfig(), BINS_PER_CLASSIC_POSITION);
  const prisma = getPrisma(env.DATABASE_URL);
  const now = Date.now();

  const wanted = arg('--pool');
  const pools = (await listActivePools(prisma)).filter(
    (pool) => wanted === undefined || pool.managedPoolId === wanted,
  );
  if (pools.length === 0) {
    log.warn(wanted ? `no active pool with id ${wanted}` : 'no pools in SHADOW mode');
    await disconnectPrisma();
    return;
  }

  const telegram = process.argv.includes('--print-only')
    ? null
    : createTelegram(env.TELEGRAM_BOT_TOKEN);

  for (const pool of pools) {
    const params = paramsForPool(
      { ...configParams, ...pool.strategyParams },
      { poolAddress: pool.poolAddress, label: pool.label, virtualNavUsd: pool.virtualNavUsd },
    );
    const report = await buildDailyReport(prisma, params, pool.managedPoolId, now, {
      includeGoLive:
        process.argv.includes('--go-live') || isWeeklyReportDay(now, params.reportTimezone),
    });
    process.stdout.write(`${report.text}\n\n`);
    await telegram?.send(pool.telegramChatId, report.text);
  }

  await disconnectPrisma();
}

main().catch(async (err) => {
  log.error(`report failed: ${errorMessage(err)}`, err);
  await disconnectPrisma().catch(() => undefined);
  process.exitCode = 1;
});
