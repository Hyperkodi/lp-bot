// Tracking error: rolling standard deviation of (token return − underlying
// return). Computed over paired snapshot series; annualization left to the
// caller (values are per-period stddev in %).

export interface PairedPricePoint {
  takenAt: Date;
  tokenPriceUsd: number;
  underlyingPriceUsd: number;
}

/**
 * Std dev (%) of return differences over consecutive paired points.
 * Points where either leg is missing/zero should be filtered out upstream.
 * Returns null with fewer than 3 usable return pairs.
 */
export function trackingErrorPct(points: PairedPricePoint[]): number | null {
  const diffs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev.tokenPriceUsd <= 0 || prev.underlyingPriceUsd <= 0) continue;
    const tokenRet = cur.tokenPriceUsd / prev.tokenPriceUsd - 1;
    const underRet = cur.underlyingPriceUsd / prev.underlyingPriceUsd - 1;
    diffs.push(tokenRet - underRet);
  }
  if (diffs.length < 3) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1);
  return Math.sqrt(variance) * 100;
}
