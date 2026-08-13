import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { Params } from './types.js';

const configSchema = z.object({
  pool: z.object({
    address: z.string(),
    label: z.string().min(1),
  }),
  loop: z.object({
    snapshot_interval_sec: z.number().int().positive(),
    max_consecutive_failures: z.number().int().positive(),
    price_divergence_alert_pct: z.number().positive(),
  }),
  position: z.object({
    virtual_nav_usd: z.number().positive(),
    width_k: z.number().positive(),
    min_total_bins: z.number().int().min(2),
    max_total_bins: z.number().int().min(2),
  }),
  compound: z.object({
    min_fees_usd: z.number().nonnegative(),
    min_fees_pct_nav: z.number().nonnegative(),
  }),
  rebalance: z.object({
    oor_dwell_min: z.number().nonnegative(),
    edge_overshoot_pct: z.number().nonnegative(),
    settle_band_pct: z.number().positive(),
    settle_min: z.number().nonnegative(),
    cost_coverage_multiple: z.number().nonnegative(),
    in_range_share_estimate: z.number().min(0).max(1),
  }),
  exit: z.object({
    vol_tvl_floor: z.number().nonnegative(),
    vol_tvl_dwell_hours: z.number().positive(),
  }),
  vol: z.object({
    fast_half_life_min: z.number().positive(),
    slow_half_life_min: z.number().positive(),
    min_samples: z.number().int().nonnegative(),
  }),
  costs: z.object({
    swap_share_of_nav: z.number().min(0).max(1),
    quote_slippage_bps: z.number().int().nonnegative(),
    rebalance_tx_count: z.number().int().positive(),
    compound_tx_count: z.number().int().positive(),
    exit_tx_count: z.number().int().positive(),
    compute_units_per_tx: z.number().int().positive(),
    signature_fee_lamports: z.number().int().nonnegative(),
  }),
  report: z.object({
    timezone: z.string().min(1),
    daily_hour_local: z.number().int().min(0).max(23),
  }),
  golive: z.object({
    min_shadow_days: z.number().positive(),
    regime_change_ratio: z.number().gt(1),
  }),
  execution: z.object({
    cluster: z.literal('devnet'),
    per_transaction_notional_sol: z.number().positive(),
    project_rolling_24h_notional_sol: z.number().positive(),
    global_rolling_24h_notional_sol: z.number().positive(),
    max_reconcile_attempts: z.number().int().positive(),
  }),
});

export type RawConfig = z.infer<typeof configSchema>;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  RPC_URL: z.string().url('RPC_URL must be a URL'),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  JUPITER_API_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

export type ExecutionConfig = {
  cluster: 'devnet';
  caps: {
    perTransactionSol: number;
    projectRolling24hSol: number;
    globalRolling24hSol: number;
  };
  maxReconcileAttempts: number;
};

export function toExecutionConfig(cfg: RawConfig): ExecutionConfig {
  return {
    cluster: cfg.execution.cluster,
    caps: {
      perTransactionSol: cfg.execution.per_transaction_notional_sol,
      projectRolling24hSol: cfg.execution.project_rolling_24h_notional_sol,
      globalRolling24hSol: cfg.execution.global_rolling_24h_notional_sol,
    },
    maxReconcileAttempts: cfg.execution.max_reconcile_attempts,
  };
}

/**
 * `MAX_BINS_PER_POSITION` in @meteora-ag/dlmm 1.9.14 is 1400 (extended
 * positions), but a classic single position covers `DEFAULT_BIN_PER_POSITION`
 * = 70 bins. Phase 1 models a single classic position, so 70 is the ceiling we
 * validate against. The constant is read from the SDK rather than hardcoded;
 * see src/poller/sdkConstants.ts.
 */
export function toParams(cfg: RawConfig, maxBinsPerPosition: number): Params {
  if (cfg.position.max_total_bins > maxBinsPerPosition) {
    throw new Error(
      `position.max_total_bins (${cfg.position.max_total_bins}) exceeds the SDK's ` +
        `bins-per-position limit (${maxBinsPerPosition})`,
    );
  }
  if (cfg.position.min_total_bins > cfg.position.max_total_bins) {
    throw new Error('position.min_total_bins must not exceed position.max_total_bins');
  }

  return {
    poolAddress: cfg.pool.address,
    poolLabel: cfg.pool.label,

    snapshotIntervalSec: cfg.loop.snapshot_interval_sec,
    maxConsecutiveFailures: cfg.loop.max_consecutive_failures,
    priceDivergenceAlertPct: cfg.loop.price_divergence_alert_pct,

    virtualNavUsd: cfg.position.virtual_nav_usd,
    widthK: cfg.position.width_k,
    minTotalBins: cfg.position.min_total_bins,
    maxTotalBins: cfg.position.max_total_bins,

    minFeesUsd: cfg.compound.min_fees_usd,
    minFeesPctNav: cfg.compound.min_fees_pct_nav,

    oorDwellMin: cfg.rebalance.oor_dwell_min,
    edgeOvershootPct: cfg.rebalance.edge_overshoot_pct,
    settleBandPct: cfg.rebalance.settle_band_pct,
    settleMin: cfg.rebalance.settle_min,
    costCoverageMultiple: cfg.rebalance.cost_coverage_multiple,
    inRangeShareEstimate: cfg.rebalance.in_range_share_estimate,

    volTvlFloor: cfg.exit.vol_tvl_floor,
    volTvlDwellHours: cfg.exit.vol_tvl_dwell_hours,

    volFastHalfLifeMin: cfg.vol.fast_half_life_min,
    volSlowHalfLifeMin: cfg.vol.slow_half_life_min,
    volMinSamples: cfg.vol.min_samples,

    swapShareOfNav: cfg.costs.swap_share_of_nav,
    quoteSlippageBps: cfg.costs.quote_slippage_bps,
    rebalanceTxCount: cfg.costs.rebalance_tx_count,
    compoundTxCount: cfg.costs.compound_tx_count,
    exitTxCount: cfg.costs.exit_tx_count,
    computeUnitsPerTx: cfg.costs.compute_units_per_tx,
    signatureFeeLamports: cfg.costs.signature_fee_lamports,

    reportTimezone: cfg.report.timezone,
    reportDailyHourLocal: cfg.report.daily_hour_local,

    goLiveMinShadowDays: cfg.golive.min_shadow_days,
    goLiveRegimeChangeRatio: cfg.golive.regime_change_ratio,
  };
}

/**
 * Overlays a ManagedPool's identity and sizing onto the canonical strategy.
 *
 * The strategy is shared across every pool; the position size is not — it is the
 * capital that project would actually deploy, and it changes the answer.
 */
export function paramsForPool(
  strategyParams: Params,
  pool: { poolAddress: string; label: string; virtualNavUsd: number },
): Params {
  return {
    ...strategyParams,
    poolAddress: pool.poolAddress,
    poolLabel: pool.label,
    virtualNavUsd: pool.virtualNavUsd,
  };
}

/**
 * The shipped config, located relative to this file rather than the process
 * cwd — the loop, the bot, and the CLIs are separate long-running processes
 * and none of them should break because a service manager set WorkingDirectory
 * somewhere else. LP_SHADOW_CONFIG still overrides.
 */
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config/default.toml', import.meta.url));

export function loadRawConfig(path?: string): RawConfig {
  const file = resolve(path ?? process.env.LP_SHADOW_CONFIG ?? DEFAULT_CONFIG_PATH);
  const parsed = parseToml(readFileSync(file, 'utf8'));
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid config at ${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Applies dotted-path overrides (`rebalance.oor_dwell_min=45`) to a raw config
 * before it is turned into `Params`. Used by the replay harness for sweeps.
 */
export function applyOverrides(cfg: RawConfig, overrides: Record<string, unknown>): RawConfig {
  const clone = structuredClone(cfg) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const segments = path.split('.');
    let cursor = clone;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (typeof next !== 'object' || next === null) {
        throw new Error(`override path "${path}" does not exist in the config`);
      }
      cursor = next as Record<string, unknown>;
    }
    const leaf = segments.at(-1)!;
    if (!(leaf in cursor)) throw new Error(`override path "${path}" does not exist in the config`);
    cursor[leaf] = value;
  }
  const result = configSchema.safeParse(clone);
  if (!result.success) {
    throw new Error(`config invalid after overrides:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
