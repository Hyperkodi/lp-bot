/**
 * The only import surface the bot layer is allowed (eslint.config.js enforces
 * it). Everything here is documented in docs/FRONTEND_TELEGRAM_BOT.md §3.
 *
 * `issueHandoff` is exported for scripts/issue-handoff.ts and the parent bot's
 * future integration — the Telegram bot itself never issues tokens.
 */
export { createService } from './api.js';
export { ServiceError, type ServiceErrorCode } from './errors.js';
export { issueHandoff, newHandoffToken } from './handoff.js';
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
} from './types.js';
