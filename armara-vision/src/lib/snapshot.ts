// Hourly snapshot job: pulls live data through the adapters, computes derived
// metrics, and persists AssetSnapshot / PoolSnapshot / IssuerSnapshot rows —
// the time series everything else (sparklines, premium history, tracking
// error, degradation fallback) is built from.
//
// Failure policy: per-asset try/catch. One provider being down never aborts
// the run; assets that fail simply keep their previous snapshot as the most
// recent row.
import { prisma } from "./db";
import { coingecko } from "./adapters/coingecko";
import { geckoterminal } from "./adapters/geckoterminal";
import { defillama } from "./adapters/defillama";
import { equityPrices } from "./adapters/stocks";
import { premiumBps } from "./metrics/premium";
import { estimateSlippageBps } from "./metrics/slippage";
import { isUsMarketOpen } from "./metrics/market-hours";
import { refreshNews } from "./news";
import { evaluateAlerts } from "./alerts";

export interface SnapshotRunResult {
  takenAt: Date;
  assetsSnapshotted: number;
  assetsFailed: number;
  issuersSnapshotted: number;
  alertsFired: number;
  errors: string[];
}

export async function runSnapshot(): Promise<SnapshotRunResult> {
  const takenAt = new Date();
  const marketOpen = isUsMarketOpen(takenAt);
  const errors: string[] = [];

  const assets = await prisma.asset.findMany({
    where: { active: true },
    include: { deployments: true },
  });

  // Resolve missing CoinGecko ids with ONE category-list call per run (a
  // per-asset lookup would multiply retry/backoff time when the API is down).
  if (assets.some((a) => !a.coingeckoId)) {
    try {
      const listed = await coingecko.listTokenizedStocks();
      const bySymbol = new Map(listed.data.map((t) => [t.symbol.toUpperCase(), t.coingeckoId]));
      for (const asset of assets) {
        if (asset.coingeckoId) continue;
        const id = bySymbol.get(asset.symbol.toUpperCase());
        if (id) {
          await prisma.asset.update({ where: { id: asset.id }, data: { coingeckoId: id } });
          asset.coingeckoId = id;
        }
      }
    } catch (e) {
      errors.push(`coingecko id resolution: ${e instanceof Error ? e.message : e}`);
    }
  }

  // One batched market call for every asset with a known id.
  const ids = assets.map((a) => a.coingeckoId).filter((x): x is string => !!x);
  const marketById = new Map<string, Awaited<ReturnType<typeof coingecko.getTokenMarkets>>["data"][number]>();
  try {
    const markets = await coingecko.getTokenMarkets(ids);
    for (const m of markets.data) marketById.set(m.coingeckoId, m);
  } catch (e) {
    errors.push(`coingecko batch: ${e instanceof Error ? e.message : e}`);
  }

  // Underlying quotes: one call per distinct ticker (rate-limited in adapter).
  const tickers = [...new Set(assets.map((a) => a.underlyingTicker))];
  const quoteByTicker = new Map<string, number | null>();
  for (const t of tickers) {
    try {
      const q = await equityPrices.getQuote(t);
      quoteByTicker.set(t, q.data.priceUsd);
    } catch (e) {
      quoteByTicker.set(t, null);
      errors.push(`equity quote ${t}: ${e instanceof Error ? e.message : e}`);
    }
  }

  let ok = 0;
  let failed = 0;
  for (const asset of assets) {
    try {
      const market = asset.coingeckoId ? marketById.get(asset.coingeckoId) : undefined;

      // Pool data across the asset's deployments (skip chains without an address).
      let liquidityUsd: number | null = null;
      let dexVolume24hUsd: number | null = null;
      for (const dep of asset.deployments) {
        if (!dep.address || !dep.geckoTerminalNetwork) continue;
        try {
          const pools = await geckoterminal.getTokenPools(dep.geckoTerminalNetwork, dep.address);
          for (const p of pools.data) {
            liquidityUsd = (liquidityUsd ?? 0) + (p.liquidityUsd ?? 0);
            dexVolume24hUsd = (dexVolume24hUsd ?? 0) + (p.volume24hUsd ?? 0);
            await prisma.poolSnapshot.create({
              data: {
                assetId: asset.id,
                chain: dep.chain,
                poolAddress: p.poolAddress,
                dexName: p.dexName,
                takenAt,
                liquidityUsd: p.liquidityUsd,
                volume24hUsd: p.volume24hUsd,
                priceUsd: p.priceUsd,
              },
            });
          }
        } catch (e) {
          errors.push(`pools ${asset.id}/${dep.chain}: ${e instanceof Error ? e.message : e}`);
        }
      }

      const tokenPriceUsd = market?.priceUsd ?? null;
      const underlyingPriceUsd = quoteByTicker.get(asset.underlyingTicker) ?? null;
      const premium =
        tokenPriceUsd != null && underlyingPriceUsd != null && underlyingPriceUsd > 0
          ? premiumBps(tokenPriceUsd, underlyingPriceUsd)
          : null;

      // Nothing live at all this run → don't write an empty row; the previous
      // snapshot stays authoritative ("as of" its own timestamp).
      if (tokenPriceUsd == null && underlyingPriceUsd == null && liquidityUsd == null) {
        failed++;
        continue;
      }

      const snap = await prisma.assetSnapshot.create({
        data: {
          assetId: asset.id,
          takenAt,
          tokenPriceUsd,
          underlyingPriceUsd,
          premiumBps: premium,
          marketOpen,
          marketCapUsd: market?.marketCapUsd ?? null,
          volume24hUsd: market?.volume24hUsd ?? null,
          dexVolume24hUsd,
          liquidityUsd,
          slippage100kBps: estimateSlippageBps(100_000, liquidityUsd),
          slippage1mBps: estimateSlippageBps(1_000_000, liquidityUsd),
          totalSupply: market?.totalSupply ?? null,
          source: "live",
        },
      });

      // Infer supply change vs previous live snapshot (mint/redeem proxy).
      const prev = await prisma.assetSnapshot.findFirst({
        where: { assetId: asset.id, id: { not: snap.id }, totalSupply: { not: null }, source: "live" },
        orderBy: { takenAt: "desc" },
      });
      if (prev?.totalSupply != null && snap.totalSupply != null && prev.totalSupply !== snap.totalSupply) {
        const delta = snap.totalSupply - prev.totalSupply;
        await prisma.supplyEvent.create({
          data: {
            assetId: asset.id,
            occurredAt: takenAt,
            deltaSupply: delta,
            deltaUsd: tokenPriceUsd != null ? delta * tokenPriceUsd : null,
            kind: "inferred",
          },
        });
      }

      ok++;
    } catch (e) {
      failed++;
      errors.push(`asset ${asset.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Issuer rollups: distributed value from this run's snapshots + DefiLlama TVL.
  const issuers = await prisma.issuer.findMany({ include: { assets: { where: { active: true } } } });
  let issuersSnapshotted = 0;
  for (const issuer of issuers) {
    try {
      const rows = await prisma.assetSnapshot.findMany({
        where: { takenAt, asset: { issuerId: issuer.id } },
        select: { marketCapUsd: true },
      });
      const totalValueUsd = rows.reduce((s, r) => s + (r.marketCapUsd ?? 0), 0) || null;

      let defiLlamaTvl: number | null = null;
      if (issuer.defiLlamaSlug) {
        try {
          const tvl = await defillama.getProtocolTvl(issuer.defiLlamaSlug);
          defiLlamaTvl = tvl.data.tvlUsd;
        } catch (e) {
          errors.push(`defillama ${issuer.id}: ${e instanceof Error ? e.message : e}`);
        }
      }

      await prisma.issuerSnapshot.create({
        data: {
          issuerId: issuer.id,
          takenAt,
          totalValueUsd,
          defiLlamaTvl,
          assetCount: issuer.assets.length,
        },
      });
      issuersSnapshotted++;
    } catch (e) {
      errors.push(`issuer ${issuer.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // News refresh piggybacks on the hourly run; failures never affect snapshots.
  try {
    const news = await refreshNews();
    errors.push(...news.errors.map((e) => `news: ${e}`));
  } catch (e) {
    errors.push(`news: ${e instanceof Error ? e.message : e}`);
  }

  // Alert evaluation runs last so it sees this run's snapshots.
  let alertsFired = 0;
  try {
    const alerts = await evaluateAlerts();
    alertsFired = alerts.fired;
    errors.push(...alerts.errors.map((e) => `alerts: ${e}`));
  } catch (e) {
    errors.push(`alerts: ${e instanceof Error ? e.message : e}`);
  }

  return { takenAt, assetsSnapshotted: ok, assetsFailed: failed, issuersSnapshotted, alertsFired, errors };
}
