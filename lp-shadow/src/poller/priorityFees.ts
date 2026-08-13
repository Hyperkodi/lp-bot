/**
 * Current priority-fee estimate, in micro-lamports per compute unit.
 *
 * Verified 2026-08: Helius serves `getPriorityFeeEstimate` as a JSON-RPC method
 * on the same RPC URL, taking
 *   [{ accountKeys: [...], options: { priorityLevel: "Medium", recommended: true } }]
 * and returning `{ priorityFeeEstimate }`.
 *
 * Any RPC that does not implement it falls back to the standard
 * `getRecentPrioritizationFees`, whose median is used. Both paths are read-only.
 */
import { log } from '../logger.js';
import { fetchJson } from './http.js';

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };

async function rpc<T>(url: string, method: string, params: unknown): Promise<RpcResponse<T>> {
  return fetchJson<RpcResponse<T>>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'lp-shadow', method, params }),
    timeoutMs: 8_000,
  });
}

export type PriorityFeeEstimate = {
  microLamportsPerCu: number;
  source: 'helius' | 'recent-prioritization-fees' | 'fallback';
};

/** Used only when both RPC paths fail; deliberately non-zero so costs are never free. */
const FALLBACK_MICRO_LAMPORTS_PER_CU = 10_000;

export async function fetchPriorityFee(
  rpcUrl: string,
  accountKeys: string[],
): Promise<PriorityFeeEstimate> {
  try {
    const res = await rpc<{ priorityFeeEstimate?: number }>(rpcUrl, 'getPriorityFeeEstimate', [
      {
        accountKeys,
        options: { priorityLevel: 'Medium', recommended: true },
      },
    ]);
    const estimate = res.result?.priorityFeeEstimate;
    if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0) {
      return { microLamportsPerCu: estimate, source: 'helius' };
    }
  } catch (err) {
    log.debug('getPriorityFeeEstimate unavailable, falling back', err);
  }

  try {
    const res = await rpc<{ slot: number; prioritizationFee: number }[]>(
      rpcUrl,
      'getRecentPrioritizationFees',
      [accountKeys],
    );
    const fees = (res.result ?? [])
      .map((entry) => entry.prioritizationFee)
      .filter((fee) => Number.isFinite(fee))
      .sort((a, b) => a - b);
    if (fees.length > 0) {
      const median = fees[Math.floor(fees.length / 2)]!;
      return { microLamportsPerCu: median, source: 'recent-prioritization-fees' };
    }
  } catch (err) {
    log.debug('getRecentPrioritizationFees unavailable', err);
  }

  return { microLamportsPerCu: FALLBACK_MICRO_LAMPORTS_PER_CU, source: 'fallback' };
}
