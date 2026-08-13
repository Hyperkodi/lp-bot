import type { Decision } from '../types.js';

export type LaunchGuardContext = {
  poolCreatedAtMs: number;
  nowMs: number;
  launchGuardHours: number;
};

export type LaunchGuardResult = {
  decision: Decision;
  suppressedDecision: Decision | null;
  active: boolean;
  expiresAtMs: number;
};

/**
 * Holds rebalances during launch price discovery while retaining the complete
 * would-be decision as tuning evidence. Compounding and founder-directed exits
 * remain available; custody must never turn a safety guard into a withdrawal
 * delay.
 */
export function applyLaunchGuard(
  decision: Decision,
  context: LaunchGuardContext,
): LaunchGuardResult {
  if (
    !Number.isFinite(context.poolCreatedAtMs) ||
    !Number.isFinite(context.nowMs) ||
    !Number.isFinite(context.launchGuardHours) ||
    context.launchGuardHours < 0
  ) {
    throw new Error('launch guard requires finite timestamps and non-negative hours');
  }

  const expiresAtMs = context.poolCreatedAtMs + context.launchGuardHours * 60 * 60 * 1_000;
  const active = context.nowMs < expiresAtMs;
  if (!active || decision.kind !== 'REBALANCE') {
    return { decision, suppressedDecision: null, active, expiresAtMs };
  }

  return {
    active: true,
    expiresAtMs,
    suppressedDecision: decision,
    decision: {
      kind: 'HOLD',
      reasons: [
        `launch guard active until ${new Date(expiresAtMs).toISOString()}; would-be REBALANCE suppressed`,
        ...decision.reasons.map((reason) => `would-be REBALANCE: ${reason}`),
      ],
    },
  };
}

