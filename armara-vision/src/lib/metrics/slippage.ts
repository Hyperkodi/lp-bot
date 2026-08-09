// Order-book-free slippage estimate from AMM liquidity.
//
// Model: constant-product pool with total reserve value L (USD), assumed
// balanced (each side ≈ L/2). Buying `order` USD of the token moves price
// such that execution slippage ≈ order / (L/2 + order). This understates
// slippage for concentrated-liquidity pools out of range and overstates it
// in-range — it's a screening estimate, not an execution quote, and is
// labeled as such in the UI.

export function estimateSlippageBps(orderUsd: number, totalLiquidityUsd: number | null): number | null {
  if (!totalLiquidityUsd || totalLiquidityUsd <= 0) return null;
  const half = totalLiquidityUsd / 2;
  const slippage = orderUsd / (half + orderUsd);
  return slippage * 10_000;
}

export const ORDER_SIZES_USD = [100_000, 1_000_000] as const;
