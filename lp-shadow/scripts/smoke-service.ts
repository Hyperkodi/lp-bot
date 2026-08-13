/**
 * End-to-end smoke of the service layer against a seeded scratch database:
 * every method the Telegram bot calls, executed for real, with hard
 * assertions. Complements scripts/seed-synthetic.ts:
 *
 *   pnpm exec tsx scripts/seed-synthetic.ts --hours 48 --wipe
 *   pnpm smoke:service
 *
 * Exits non-zero on the first violated invariant. Local dev aid — run it at a
 * scratch database, never at one holding a real shadow run.
 */
import 'dotenv/config';
import { getPrisma } from '../src/ledger/prisma.js';
import { loadEnv } from '../src/config.js';
import { log } from '../src/logger.js';
import { issueHandoff } from '../src/service/handoff.js';
import { createService, ServiceError } from '../src/service/index.js';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`SMOKE FAIL: ${label}`);
  log.info(`ok: ${label}`);
}

async function main(): Promise<void> {
  const service = await createService();
  const prisma = getPrisma(loadEnv().DATABASE_URL);

  // The seeder's tenant is the fixture.
  const tenant = await service.getTenantByChatId('synthetic-seed');
  assert(tenant, 'seeded tenant resolves by chat id');

  const pools = await service.listPools(tenant.tenantId);
  assert(pools.length >= 1, 'seeded tenant has a pool');
  const pool = pools[0]!;
  assert(pool.daysOfData > 0, 'seeded pool reports days of data');

  const status = await service.getStatus(tenant.tenantId);
  assert(status.html.length > 0 && status.html.includes('lp-shadow'), 'status renders HTML');

  const why = await service.getWhy(tenant.tenantId);
  assert(why.pool.managedPoolId === pool.managedPoolId, 'why targets the seeded pool');

  const verdict = await service.getVerdict(tenant.tenantId);
  assert(verdict.lines.length === 3, 'verdict has three gate lines');

  const replay = await service.runReplay(tenant.tenantId);
  assert(replay.snapshots > 0, 'replay sees the seeded snapshots');
  assert(replay.results.length >= 1, 'replay produced variant results');
  for (const r of replay.results) {
    assert(Number.isFinite(r.finalNavUsd) && Number.isFinite(r.hodlNavUsd),
      `replay variant ${r.variant} has finite NAVs`);
  }

  const strategy = await service.getStrategy();
  assert(strategy.version >= 1, 'a canonical strategy exists');

  // Handoff round trip with a throwaway identity.
  const chatId = `smoke-${Date.now()}`;
  const { token } = await issueHandoff(prisma, { externalUserId: chatId, label: 'Smoke' });
  const redeemed = await service.redeemHandoff(token, chatId);
  assert(redeemed.telegramChatId === chatId, 'handoff round-trips');
  const replayed = await service.redeemHandoff(token, chatId).then(
    () => false,
    (err) => err instanceof ServiceError && err.code === 'HANDOFF_INVALID',
  );
  assert(replayed, 'a redeemed token cannot be redeemed twice');

  // Mode transitions end where they started.
  assert((await service.pausePool(tenant.tenantId)).mode === 'PAUSED', 'pause works');
  assert((await service.resumePool(tenant.tenantId)).mode === 'SHADOW', 'resume works');

  // Input validation without touching the network.
  const badAddress = await service.previewPool('not-an-address').then(
    () => false,
    (err) => err instanceof ServiceError && err.code === 'INVALID_INPUT',
  );
  assert(badAddress, 'previewPool rejects a malformed address');

  log.info('smoke passed: every service method the bot calls executed against the scratch DB');
  await service.close();
}

main().catch(async (err) => {
  log.error(err instanceof Error ? err.message : String(err), err);
  process.exitCode = 1;
});
