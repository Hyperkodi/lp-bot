import { describe, expect, it } from 'vitest';
import {
  assertPermanentInitialLiquidityAction,
  enforcePositionPolicy,
} from '../src/execution/initialLiquidityPolicy.js';

describe('permanent initial-liquidity execution policy', () => {
  it('allows opening and an explicit founder withdrawal', () => {
    expect(() => assertPermanentInitialLiquidityAction('OPEN_POSITION', 'SYSTEM')).not.toThrow();
    expect(() => assertPermanentInitialLiquidityAction('WITHDRAW', 'FOUNDER')).not.toThrow();
  });

  it.each(['COMPOUND', 'REBALANCE', 'EXIT', 'FEE_SETTLEMENT'] as const)(
    'blocks automatic %s for the initial position',
    (action) => {
      expect(() => assertPermanentInitialLiquidityAction(action, 'SYSTEM')).toThrow(
        /permanent initial liquidity forbids/i,
      );
    },
  );

  it('blocks a system withdrawal and rejects a missing initiator', () => {
    expect(() => assertPermanentInitialLiquidityAction('WITHDRAW', 'SYSTEM')).toThrow(
      /only explicit founder withdrawal/i,
    );
    expect(() =>
      enforcePositionPolicy('WITHDRAW', { positionRole: 'PERMANENT_INITIAL' }),
    ).toThrow(/requires SYSTEM or FOUNDER/i);
  });

  it('does not change the legacy managed-position policy', () => {
    expect(() => enforcePositionPolicy('REBALANCE', {})).not.toThrow();
  });
});
