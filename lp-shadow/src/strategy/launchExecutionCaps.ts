import type { ExecutionCaps } from '../execution/types.js';
import type { InitialLiquidityLaunchPlan } from './launchPlanner.js';

export type LaunchExecutionCapReadiness = {
  status: 'WITHIN_CONFIGURED_CAPS' | 'BLOCKED_BY_CONFIGURED_CAPS';
  configuredCaps: ExecutionCaps;
  existingRollingNotionalSol: { projectSol: number; globalSol: number };
  plannedNotionalSol: {
    createPool: number;
    openPosition: number;
    combined: number;
  };
  blockers: string[];
};

function nonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
}

export function assessLaunchExecutionCaps(
  plan: InitialLiquidityLaunchPlan,
  configuredCaps: ExecutionCaps,
  existingRollingNotionalSol = { projectSol: 0, globalSol: 0 },
): LaunchExecutionCapReadiness {
  for (const [name, value] of Object.entries(configuredCaps)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  }
  nonNegativeFinite(existingRollingNotionalSol.projectSol, 'project rolling notional');
  nonNegativeFinite(existingRollingNotionalSol.globalSol, 'global rolling notional');

  const createPool = plan.creationCost.knownRequiredAccountRentSol;
  const openPosition = plan.deposit.initialLiquidityValueSol;
  const combined = createPool + openPosition;
  const blockers: string[] = [];
  if (openPosition > configuredCaps.perTransactionSol) {
    blockers.push(
      `Planned ${openPosition.toFixed(6)} SOL position notional exceeds the configured ${configuredCaps.perTransactionSol} SOL per-transaction cap.`,
    );
  }
  if (existingRollingNotionalSol.projectSol + combined > configuredCaps.projectRolling24hSol) {
    blockers.push(
      `Planned launch would exceed the configured ${configuredCaps.projectRolling24hSol} SOL project 24-hour cap.`,
    );
  }
  if (existingRollingNotionalSol.globalSol + combined > configuredCaps.globalRolling24hSol) {
    blockers.push(
      `Planned launch would exceed the configured ${configuredCaps.globalRolling24hSol} SOL global 24-hour cap.`,
    );
  }
  return {
    status: blockers.length > 0 ? 'BLOCKED_BY_CONFIGURED_CAPS' : 'WITHIN_CONFIGURED_CAPS',
    configuredCaps: { ...configuredCaps },
    existingRollingNotionalSol: { ...existingRollingNotionalSol },
    plannedNotionalSol: { createPool, openPosition, combined },
    blockers,
  };
}

