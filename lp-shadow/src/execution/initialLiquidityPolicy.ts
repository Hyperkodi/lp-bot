import type { ExecutionAction } from './types.js';

export const PERMANENT_INITIAL_POSITION_ROLE = 'PERMANENT_INITIAL' as const;

export type InitialLiquidityInitiator = 'SYSTEM' | 'FOUNDER';

/**
 * The initial position may be opened once and observed indefinitely. Principal
 * movement after opening is reserved for an explicit founder withdrawal.
 */
export function assertPermanentInitialLiquidityAction(
  action: ExecutionAction,
  initiatedBy: InitialLiquidityInitiator,
): void {
  if (action === 'OPEN_POSITION') return;
  if (action === 'WITHDRAW' && initiatedBy === 'FOUNDER') return;
  throw new Error(
    `permanent initial liquidity forbids ${initiatedBy.toLowerCase()} ${action}; only explicit founder withdrawal may remove it`,
  );
}

export function enforcePositionPolicy(
  action: ExecutionAction,
  detail: Record<string, unknown>,
): void {
  if (detail.positionRole !== PERMANENT_INITIAL_POSITION_ROLE) return;
  if (detail.initiatedBy !== 'SYSTEM' && detail.initiatedBy !== 'FOUNDER') {
    throw new Error('permanent initial liquidity requires SYSTEM or FOUNDER initiatedBy');
  }
  assertPermanentInitialLiquidityAction(action, detail.initiatedBy);
}
