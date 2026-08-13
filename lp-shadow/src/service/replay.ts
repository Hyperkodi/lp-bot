/**
 * /replay for the bot: the sweep from config/sweep.toml over one pool's stored
 * snapshots, sized at that pool's NAV.
 *
 * Unlike `pnpm replay`, nothing is persisted — a chat command run twice should
 * not leave twice the rows — and the window defaults to the last 30 days
 * rather than all history, because this runs synchronously in the bot process
 * on a user-repeatable command and a long-shadowed pool's full history is
 * hundreds of thousands of rows. The CLI remains the way to replay everything
 * and record it.
 *
 * Known parity caveat: the sweep base comes from the shipped config, not the
 * pool's stamped strategy version — same as the replay CLI. Once default.toml
 * drifts from the version a pool is stamped with, the "baseline" variant
 * describes the shipped defaults, not the strategy that produced the ledger.
 */
import { fileURLToPath } from 'node:url';
import { applyOverrides, loadRawConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { errorMessage } from '../logger.js';
import { loadSnapshots, loadVariants, runVariant, type Variant } from '../replay/replay.js';
import { ServiceError } from './errors.js';
import { summarize, type PoolRow } from './pools.js';
import type { ReplayReport } from './types.js';

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
/** Located relative to this file, not the process cwd — see config.ts. */
const SWEEP_FILE = fileURLToPath(new URL('../../config/sweep.toml', import.meta.url));

export async function runReplayForPool(
  prisma: PrismaClient,
  row: PoolRow,
  opts: { fromDays?: number } = {},
): Promise<ReplayReport> {
  const now = Date.now();
  const from = new Date(now - (opts.fromDays ?? DEFAULT_WINDOW_DAYS) * MS_PER_DAY);
  const to = new Date(now);

  const pool = await summarize(prisma, row);
  const stored = await loadSnapshots(prisma, row.id, from, to);
  if (stored.length === 0) {
    return { pool, fromTs: from.toISOString(), toTs: to.toISOString(), snapshots: 0, results: [] };
  }

  // The pool's own identity and size, exactly as the replay CLI overlays them —
  // sizing changes the answer, so the TOML default must not leak in. Config
  // problems (missing sweep file, emptied variants, drifted override paths)
  // are operational conditions, not bugs — surface them as ServiceErrors the
  // bot can show.
  let variants: Variant[];
  try {
    const base = applyOverrides(loadRawConfig(), {
      'pool.address': row.poolAddress,
      'pool.label': row.label,
      'position.virtual_nav_usd': Number(row.virtualNavUsd.toString()),
    });
    variants = loadVariants(base, SWEEP_FILE);
  } catch (err) {
    throw new ServiceError(
      'INVALID_INPUT',
      `The replay sweep configuration is unavailable — an operator needs to look at config/sweep.toml (${errorMessage(err)}).`,
    );
  }

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
