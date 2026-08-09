// Chart + trading data for one asset: resolves its most liquid DEX pool
// (caching the discovered token address back onto the deployment), returns
// OHLCV candles, and falls back to our snapshot series when GeckoTerminal
// is unreachable — the chart never renders blank.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { geckoterminal, getPoolOhlcv } from "@/lib/adapters/geckoterminal";
import type { PoolData } from "@/lib/adapters/types";

export const dynamic = "force-dynamic";

const TIMEFRAMES: Record<string, { tf: "minute" | "hour" | "day"; agg: number }> = {
  "15m": { tf: "minute", agg: 15 },
  "1h": { tf: "hour", agg: 1 },
  "4h": { tf: "hour", agg: 4 },
  "1d": { tf: "day", agg: 1 },
};

async function resolveBestPool(assetId: string): Promise<PoolData | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { deployments: true },
  });
  if (!asset) return null;

  const pools: PoolData[] = [];
  for (const dep of asset.deployments) {
    if (!dep.geckoTerminalNetwork) continue;
    try {
      if (dep.address) {
        const r = await geckoterminal.getTokenPools(dep.geckoTerminalNetwork, dep.address);
        pools.push(...r.data);
      } else {
        // Discover by symbol; keep only exact base-symbol matches, then cache
        // the token address so future runs skip the search.
        const r = await geckoterminal.searchPools(asset.symbol, dep.geckoTerminalNetwork);
        const exact = r.data.filter(
          (p) => p.baseTokenSymbol?.toUpperCase() === asset.symbol.toUpperCase(),
        );
        pools.push(...exact);
        const withAddr = exact.find((p) => p.baseTokenAddress);
        if (withAddr?.baseTokenAddress) {
          await prisma.assetDeployment.update({
            where: { id: dep.id },
            data: { address: withAddr.baseTokenAddress },
          });
        }
      }
    } catch {
      // provider down — fall through to snapshot fallback
    }
  }
  if (pools.length === 0) return null;
  return pools.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const tfKey = req.nextUrl.searchParams.get("tf") ?? "1h";
  const { tf, agg } = TIMEFRAMES[tfKey] ?? TIMEFRAMES["1h"];

  const asset = await prisma.asset.findUnique({ where: { id }, include: { deployments: true } });
  if (!asset) return NextResponse.json({ error: "unknown asset" }, { status: 404 });

  const pool = await resolveBestPool(id);

  let candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let source: "geckoterminal" | "snapshots" = "geckoterminal";
  if (pool) {
    try {
      const r = await getPoolOhlcv(pool.network, pool.poolAddress, tf, agg);
      candles = r.candles;
    } catch {
      // fall through
    }
  }

  // Snapshot series always fetched: underlying overlay + candle fallback.
  const snaps = await prisma.assetSnapshot.findMany({
    where: { assetId: id },
    orderBy: { takenAt: "asc" },
    take: 1000,
  });
  const underlying = snaps
    .filter((s) => s.underlyingPriceUsd != null)
    .map((s) => ({ time: Math.floor(s.takenAt.getTime() / 1000), value: s.underlyingPriceUsd as number }));

  if (candles.length === 0) {
    source = "snapshots";
    candles = snaps
      .filter((s) => s.tokenPriceUsd != null)
      .map((s) => {
        const p = s.tokenPriceUsd as number;
        return { time: Math.floor(s.takenAt.getTime() / 1000), open: p, high: p, low: p, close: p, volume: s.dexVolume24hUsd ?? 0 };
      });
  }

  const solanaDep = asset.deployments.find((d) => d.chain === "solana");
  return NextResponse.json({
    symbol: asset.symbol,
    source,
    pool: pool ? { address: pool.poolAddress, network: pool.network, dex: pool.dexName, liquidityUsd: pool.liquidityUsd } : null,
    // mint for the Solana trade widget: prefer the resolved deployment address
    solanaMint: solanaDep?.address ?? (pool?.network === "solana" ? pool.baseTokenAddress : null),
    candles,
    underlying,
  });
}
