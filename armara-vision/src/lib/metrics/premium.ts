// Premium/discount of the on-chain token vs its underlying equity —
// the core dislocation metric. Positive = token trades rich.

export function premiumBps(tokenPriceUsd: number, underlyingPriceUsd: number): number {
  return (tokenPriceUsd / underlyingPriceUsd - 1) * 10_000;
}

/** Institutional flag threshold: anything beyond ±50bps is notable. */
export const PREMIUM_FLAG_BPS = 50;

export function isDislocated(bps: number, threshold = PREMIUM_FLAG_BPS): boolean {
  return Math.abs(bps) > threshold;
}
