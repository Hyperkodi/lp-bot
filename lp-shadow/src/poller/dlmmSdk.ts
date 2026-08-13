/**
 * Single loading point for @meteora-ag/dlmm (verified against 1.9.14).
 *
 * The package's ESM build contains a bare directory import into
 * @coral-xyz/anchor that Node refuses to resolve, so the CJS build is loaded
 * through `createRequire` instead. `module.exports` there *is* the DLMM class,
 * with every named export hung off it as a property — which is also what the
 * ESM default export would have been, so nothing downstream has to care.
 *
 * Types still come from the package's own .d.ts via `import type`, which emits
 * no runtime import.
 */
import { createRequire } from 'node:module';
import type DLMMClass from '@meteora-ag/dlmm';

const require = createRequire(import.meta.url);

type DlmmModule = typeof DLMMClass & Record<string, unknown>;

export const DLMM: DlmmModule = require('@meteora-ag/dlmm') as DlmmModule;

/** Named export accessor with a clear error when the SDK's surface shifts. */
export function sdkExport<T>(name: string): T {
  const value = (DLMM as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`@meteora-ag/dlmm does not export "${name}" — check the SDK version`);
  }
  return value as T;
}
