/**
 * The only import surface the bot layer is allowed (eslint.config.js enforces
 * it as an allowlist). Everything here is documented in
 * docs/FRONTEND_TELEGRAM_BOT.md §3.
 *
 * Deliberately NOT here: `issueHandoff` — the Telegram bot never mints tokens.
 * scripts/issue-handoff.ts (and a future parent-bot integration) import
 * src/service/handoff.js directly, which the bot's boundary rule forbids.
 */
export { createService } from './api.js';
export { ServiceError, type ServiceErrorCode } from './errors.js';
export type {
  DecisionDetail,
  LpShadowService,
  PoolPreview,
  PoolSummary,
  ReplayReport,
  ReplayVariantResult,
  StatusReport,
  StrategyInfo,
  TenantRef,
  VerdictReport,
  WhyReport,
  WithdrawalReceipt,
} from './types.js';
