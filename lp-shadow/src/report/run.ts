/**
 * `pnpm report` — build and send the daily report on demand, outside the 07:00
 * schedule. Useful for checking formatting without waiting a day.
 *
 *   pnpm report              # send via Telegram (if configured) and print
 *   pnpm report --print-only # print only
 *   pnpm report --go-live    # force the weekly go-live block
 */
import 'dotenv/config';
import { loadEnv, loadRawConfig, toParams } from '../config.js';
import { disconnectPrisma, getPrisma } from '../ledger/prisma.js';
import { errorMessage, log } from '../logger.js';
import { BINS_PER_CLASSIC_POSITION } from '../poller/sdkConstants.js';
import { isWeeklyReportDay } from '../clock.js';
import { buildDailyReport } from './daily.js';
import { createTelegram } from './telegram.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const params = toParams(loadRawConfig(), BINS_PER_CLASSIC_POSITION);
  const prisma = getPrisma(env.DATABASE_URL);
  const now = Date.now();

  const report = await buildDailyReport(prisma, params, now, {
    includeGoLive:
      process.argv.includes('--go-live') || isWeeklyReportDay(now, params.reportTimezone),
  });

  process.stdout.write(`${report.text}\n`);

  if (!process.argv.includes('--print-only')) {
    const telegram = createTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
    await telegram.send(report.text);
  }

  await disconnectPrisma();
}

main().catch(async (err) => {
  log.error(`report failed: ${errorMessage(err)}`, err);
  await disconnectPrisma().catch(() => undefined);
  process.exitCode = 1;
});
