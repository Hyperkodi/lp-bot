/**
 * /replay for the bot: the sweep from config/sweep.toml over one pool's stored
 * snapshots, sized at that pool's NAV.
 *
 * Unlike `pnpm replay`, nothing is persisted — a chat command run twice should
 * not leave twice the rows. The CLI remains the way to record a run.
 */
import { applyOverrides, loadRawConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadSnapshots, loadVariants, runVariant } from '../replay/replay.js';
import { summarize, type PoolRow } from './pools.js';
import type { ReplayReport } from './types.js';

const MS_PER_DAY = 86_400_000;
const SWEEP_FILE = 'config/sweep.toml';

export async function runReplayForPool(
  prisma: PrismaClient,
  row: PoolRow,
  opts: { fromDays?: number } = {},
): Promise<ReplayReport> {
  const now = Date.now();
  const from = opts.fromDays !== undefined ? new Date(now - opts.fromDays * MS_PER_DAY) : new Date(0);
  const to = new Date(now);

  const pool = await summarize(prisma, row);
  const stored = await loadSnapshots(prisma, row.id, from, to);
  if (stored.length === 0) {
    return { pool, fromTs: from.toISOString(), toTs: to.toISOString(), snapshots: 0, results: [] };
  }

  // The pool's own identity and size, exactly as the replay CLI overlays them —
  // sizing changes the answer, so the TOML default must not leak in.
  const base = applyOverrides(loadRawConfig(), {
    'pool.address': row.poolAddress,
    'pool.label': row.label,
    'position.virtual_nav_usd': Number(row.virtualNavUsd.toString()),
  });
  const variants = loadVariants(base, SWEEP_FILE);

  const results = variants.map((variant) => {
    const result = runVariant(variant, stored);
    return {
      variant: result.variant,
      ticks: result.ticks,
      finalNavUsd: result.finalNavUsd,
      hodlNavUsd: result.hodlNavUsd,
      netVsHodlUsd: result.netVsHodlUsd,
      fullRangeUsd: result.fullRangeUsd,
      totalFeesUsd: result.totalFeesUsd,
      totalCostsUsd: result.totalCostsUsd,
      rebalances: result.rebalances,
      compounds: result.compounds,
      timeInRange: result.timeInRange,
      exited: result.exited,
    };
  });

  return {
    pool,
    fromTs: from.toISOString(),
    toTs: to.toISOString(),
    snapshots: stored.length,
    results,
  };
}
