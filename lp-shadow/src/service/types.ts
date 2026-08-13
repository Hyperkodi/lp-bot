/**
 * The service contract consumed by the Telegram bot layer.
 *
 * These shapes are the API between the back-end and `src/bot/` — the bot may
 * import nothing deeper (enforced in eslint.config.js). Keep this file in
 * lockstep with docs/FRONTEND_TELEGRAM_BOT.md §3; that document is the spec
 * the front-end was built against.
 *
 * Dates cross the boundary as ISO 8601 strings, money as plain numbers (USD),
 * so the payloads are JSON-safe if the bot ever moves out of process.
 */

export type TenantRef = {
  tenantId: string;
  externalUserId: string;
  telegramChatId: string;
  label: string;
};

export type PoolSummary = {
  managedPoolId: string;
  label: string;
  poolAddress: string;
  mode: 'SHADOW' | 'PAUSED' | 'STOPPED';
  role: 'PRIMARY' | 'REFERENCE';
  virtualNavUsd: number;
  strategyVersion: number;
  createdAt: string;
  /** Days between the pool's first stored snapshot and now; 0 before data. */
  daysOfData: number;
};

export type PoolPreview = {
  poolAddress: string;
  name: string | null;
  tvlUsd: number | null;
  vol24hUsd: number | null;
  fees24hUsd: number | null;
  binStepBps: number | null;
  currentPrice: number | null;
};

export type StatusReport = {
  pool: PoolSummary;
  /**
   * Telegram-ready HTML built by the same code as the daily report. The bot
   * sends this as-is with parse_mode HTML and must not escape it again.
   */
  html: string;
  verdictPass: boolean;
};

export type DecisionDetail = {
  kind: string;
  ts: string;
  /** The full gate trail, in evaluation order. Plain text — escape before HTML. */
  reasons: string[];
  applied: boolean;
};

export type WhyReport = {
  pool: PoolSummary;
  /** Most recent COMPOUND/REBALANCE/EXIT, however old. */
  lastNonHold: DecisionDetail | null;
  /** Most recent decision of any kind — its trail shows how close each gate is. */
  latest: DecisionDetail | null;
  /** Decision counts over the last 24h, e.g. { HOLD: 91, COMPOUND: 1 }. */
  decisions24h: Record<string, number>;
};

export type StrategyInfo = {
  version: number;
  note: string;
  createdAt: string;
  params: Record<string, unknown>;
};

export type VerdictReport = {
  pool: PoolSummary;
  shadowDays: number;
  hasRegimeChange: boolean;
  regimeRatio: number;
  beatsHodl: boolean;
  pass: boolean;
  /** Three pre-rendered "✅/❌ ..." plain-text lines. Escape before HTML. */
  lines: string[];
};

export type ReplayVariantResult = {
  variant: string;
  ticks: number;
  finalNavUsd: number;
  hodlNavUsd: number;
  netVsHodlUsd: number;
  fullRangeUsd: number;
  totalFeesUsd: number;
  totalCostsUsd: number;
  rebalances: number;
  compounds: number;
  timeInRange: number;
  exited: boolean;
};

export type ReplayReport = {
  pool: PoolSummary;
  fromTs: string;
  toTs: string;
  /** Snapshot count in the window; 0 means there is nothing to replay yet. */
  snapshots: number;
  results: ReplayVariantResult[];
};

export type LpShadowService = {
  redeemHandoff(token: string, telegramChatId: string): Promise<TenantRef>;
  getTenantByChatId(telegramChatId: string): Promise<TenantRef | null>;

  previewPool(poolAddress: string): Promise<PoolPreview>;
  addPool(
    tenantId: string,
    input: { poolAddress: string; label: string; virtualNavUsd: number },
  ): Promise<PoolSummary>;
  listPools(tenantId: string): Promise<PoolSummary[]>;

  getStatus(tenantId: string, poolRef?: string): Promise<StatusReport>;
  getWhy(tenantId: string, poolRef?: string): Promise<WhyReport>;
  getVerdict(tenantId: string, poolRef?: string): Promise<VerdictReport>;
  runReplay(
    tenantId: string,
    poolRef?: string,
    opts?: { fromDays?: number },
  ): Promise<ReplayReport>;
  getStrategy(): Promise<StrategyInfo>;

  pausePool(tenantId: string, poolRef?: string): Promise<PoolSummary>;
  resumePool(tenantId: string, poolRef?: string): Promise<PoolSummary>;
  removePool(tenantId: string, poolRef?: string): Promise<PoolSummary>;

  getBotToken(): string;
  close(): Promise<void>;
};
