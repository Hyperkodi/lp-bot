/**
 * Cost estimator. Pure given the pre-fetched quote and fee inputs; it never
 * reaches the network and never reads the clock.
 */
import type { CostEstimate, CostInputs, Params } from '../types.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

export type CostAction = 'REBALANCE' | 'COMPOUND' | 'EXIT';

function txCountFor(action: CostAction, params: Params): number {
  switch (action) {
    case 'REBALANCE':
      return params.rebalanceTxCount;
    case 'COMPOUND':
      return params.compoundTxCount;
    case 'EXIT':
      return params.exitTxCount;
  }
}

/**
 * Execution cost of the hypothetical swap leg.
 *
 * The honest number is the round-trip gap between what we put in and what the
 * router says comes out, valued at the same reference price: that single figure
 * already contains price impact and every DEX fee on the route. `slippageBps`
 * is a *tolerance*, not an expected cost, so it is deliberately not added on
 * top — doing so would double-count.
 *
 * When the quote call failed we fall back to `priceImpactPct`, and when that is
 * missing too we fall back to the configured slippage tolerance as a
 * pessimistic stand-in, so a broken quote endpoint makes rebalancing look
 * expensive rather than free.
 */
function swapCostUsd(inputs: CostInputs, params: Params): number {
  if (inputs.swapOutValueUsd !== null) {
    return Math.max(0, inputs.swapNotionalUsd - inputs.swapOutValueUsd);
  }
  if (inputs.quotePriceImpactPct !== null) {
    return Math.max(0, inputs.swapNotionalUsd * inputs.quotePriceImpactPct);
  }
  return inputs.swapNotionalUsd * (params.quoteSlippageBps / 10_000);
}

export function estimateCost(
  action: CostAction,
  inputs: CostInputs,
  params: Params,
): CostEstimate {
  const txCount = txCountFor(action, params);

  // COMPOUND claims fees and redeposits into the same range: no swap leg, and
  // the bin arrays already exist.
  const slippageUsd = action === 'COMPOUND' ? 0 : swapCostUsd(inputs, params);

  const priorityLamports =
    (txCount * params.computeUnitsPerTx * inputs.priorityFeeMicroLamportsPerCu) /
    MICRO_LAMPORTS_PER_LAMPORT;
  const priorityFeeUsd = (priorityLamports / LAMPORTS_PER_SOL) * inputs.solPriceUsd;

  const txFeesUsd =
    ((txCount * params.signatureFeeLamports) / LAMPORTS_PER_SOL) * inputs.solPriceUsd;

  // Position rent comes back when the position is closed, so it nets to zero
  // over a rebalance. Rent paid to create a bin array that did not exist before
  // is sunk — it belongs to the pool forever.
  const rentDeltaUsd =
    action === 'REBALANCE'
      ? (inputs.newBinArrayRentLamports / LAMPORTS_PER_SOL) * inputs.solPriceUsd
      : 0;

  return {
    slippageUsd,
    priorityFeeUsd,
    txFeesUsd,
    rentDeltaUsd,
    totalUsd: slippageUsd + priorityFeeUsd + txFeesUsd + rentDeltaUsd,
  };
}
