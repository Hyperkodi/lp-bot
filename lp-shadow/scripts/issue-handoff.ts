/**
 * Issues a one-time handoff token for a parent-bot user, until the parent bot
 * grows its own integration.
 *
 *   pnpm handoff:issue --user <externalUserId> --label "Some Project" [--ttl-min 15]
 *
 * Prints the token and, when BOT_USERNAME is set, the ready-made deep link.
 */
import 'dotenv/config';
import { loadEnv } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import { log } from '../src/logger.js';
import { issueHandoff } from '../src/service/handoff.js';

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const externalUserId = arg('--user');
  const label = arg('--label');
  if (!externalUserId || !label) {
    log.error('usage: pnpm handoff:issue --user <externalUserId> --label <label> [--ttl-min 15]');
    process.exitCode = 1;
    return;
  }
  const ttlRaw = arg('--ttl-min');
  const ttlMinutes = ttlRaw === undefined ? undefined : Number(ttlRaw);
  if (ttlMinutes !== undefined && !(ttlMinutes > 0)) {
    log.error('--ttl-min must be a positive number of minutes');
    process.exitCode = 1;
    return;
  }

  const env = loadEnv();
  const prisma = getPrisma(env.DATABASE_URL);
  const { token, expiresAt } = await issueHandoff(prisma, { externalUserId, label, ttlMinutes });

  process.stdout.write(`token      ${token}\n`);
  process.stdout.write(`expires    ${expiresAt.toISOString()}\n`);
  const botUsername = process.env.BOT_USERNAME;
  if (botUsername) {
    process.stdout.write(`deep link  https://t.me/${botUsername}?start=${token}\n`);
  } else {
    process.stdout.write(`deep link  https://t.me/<bot-username>?start=${token}\n`);
  }
  await disconnectPrisma();
}

main().catch(async (err) => {
  log.error(`issue-handoff failed: ${err instanceof Error ? err.message : String(err)}`, err);
  await disconnectPrisma().catch(() => undefined);
  process.exitCode = 1;
});
