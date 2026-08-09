// Alert engine. Runs after each snapshot pass; evaluates enabled AlertRules
// against stored data and writes AlertEvents (in-app delivery). The channel
// field on the rule is honored at delivery time — email/webhook senders can
// be added in deliverEvent() without touching evaluation.
import { prisma } from "./db";
import { coingecko } from "./adapters/coingecko";

const COOLDOWN_MS = 6 * 3_600_000; // don't refire the same rule+asset within 6h
const SEEN_IDS_CACHE_KEY = "alerts:seen-tokenized-stock-ids";

export interface AlertRunResult {
  evaluated: number;
  fired: number;
  errors: string[];
}

async function recentlyFired(ruleId: number, assetId: string | null): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_MS);
  const prior = await prisma.alertEvent.findFirst({
    where: { ruleId, assetId, firedAt: { gte: since } },
  });
  return !!prior;
}

async function fire(ruleId: number, assetId: string | null, value: number | null, message: string) {
  if (await recentlyFired(ruleId, assetId)) return false;
  await prisma.alertEvent.create({ data: { ruleId, assetId, value, message } });
  // TODO(delivery): switch on rule.channel here for email/webhook fan-out.
  return true;
}

export async function evaluateAlerts(): Promise<AlertRunResult> {
  const errors: string[] = [];
  let fired = 0;

  const rules = await prisma.alertRule.findMany({ where: { enabled: true } });
  const assets = await prisma.asset.findMany({
    where: { active: true },
    include: { snapshots: { orderBy: { takenAt: "desc" }, take: 1 } },
  });

  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  // Baseline snapshot ~24h back per asset, for drop/change rules.
  const baselines = new Map<string, { liquidityUsd: number | null; totalSupply: number | null }>();
  for (const a of assets) {
    const base = await prisma.assetSnapshot.findFirst({
      where: { assetId: a.id, takenAt: { lte: dayAgo } },
      orderBy: { takenAt: "desc" },
      select: { liquidityUsd: true, totalSupply: true },
    });
    if (base) baselines.set(a.id, base);
  }

  for (const rule of rules) {
    try {
      const scoped = assets.filter(
        (a) =>
          (!rule.assetId || a.id === rule.assetId) &&
          (!rule.issuerId || a.issuerId === rule.issuerId),
      );

      switch (rule.kind) {
        case "premium_bps": {
          const threshold = rule.threshold ?? 50;
          for (const a of scoped) {
            const p = a.snapshots[0]?.premiumBps;
            if (p != null && Math.abs(p) > threshold) {
              if (await fire(rule.id, a.id, p,
                `${a.symbol} ${p > 0 ? "premium" : "discount"} ${p.toFixed(1)}bps vs ${a.underlyingTicker} (threshold ±${threshold}bps)`))
                fired++;
            }
          }
          break;
        }
        case "liquidity_drop_pct": {
          const threshold = rule.threshold ?? 25;
          for (const a of scoped) {
            const now = a.snapshots[0]?.liquidityUsd;
            const base = baselines.get(a.id)?.liquidityUsd;
            if (now != null && base != null && base > 0) {
              const dropPct = (1 - now / base) * 100;
              if (dropPct > threshold) {
                if (await fire(rule.id, a.id, dropPct,
                  `${a.symbol} liquidity down ${dropPct.toFixed(1)}% over 24h ($${Math.round(base).toLocaleString()} → $${Math.round(now).toLocaleString()})`))
                  fired++;
              }
            }
          }
          break;
        }
        case "supply_change_pct": {
          const threshold = rule.threshold ?? 10;
          for (const a of scoped) {
            const now = a.snapshots[0]?.totalSupply;
            const base = baselines.get(a.id)?.totalSupply;
            if (now != null && base != null && base > 0) {
              const changePct = (now / base - 1) * 100;
              if (Math.abs(changePct) > threshold) {
                if (await fire(rule.id, a.id, changePct,
                  `${a.symbol} supply ${changePct > 0 ? "up" : "down"} ${Math.abs(changePct).toFixed(1)}% over 24h (${changePct > 0 ? "net mint" : "net redeem"})`))
                  fired++;
              }
            }
          }
          break;
        }
        case "stale_price": {
          const thresholdMin = rule.threshold ?? 360;
          for (const a of scoped) {
            const latest = a.snapshots[0];
            if (!latest?.tokenPriceUsd) continue;
            const ageMin = (Date.now() - latest.takenAt.getTime()) / 60_000;
            if (ageMin > thresholdMin) {
              if (await fire(rule.id, a.id, ageMin,
                `${a.symbol} on-chain price is stale — last update ${Math.round(ageMin / 60)}h ago`))
                fired++;
            }
          }
          break;
        }
        case "new_asset": {
          // (a) newly created rows in our own universe. Only assets added
          // AFTER the rule existed — otherwise a fresh install fires once
          // for every seeded asset.
          const hourAgo = new Date(Date.now() - 3_600_000);
          for (const a of scoped) {
            if (a.createdAt > hourAgo && a.createdAt > rule.createdAt) {
              if (await fire(rule.id, a.id, null, `New tracked asset: ${a.symbol} (${a.issuerId})`)) fired++;
            }
          }
          // (b) tokens in the CoinGecko tokenized-stock category we don't track yet
          try {
            const listed = await coingecko.listTokenizedStocks();
            const knownIds = new Set(assets.map((a) => a.coingeckoId).filter(Boolean));
            const seenRow = await prisma.cacheEntry.findUnique({ where: { key: SEEN_IDS_CACHE_KEY } });
            const seen = new Set<string>(seenRow ? JSON.parse(seenRow.value) : []);
            const firstRun = !seenRow;
            for (const t of listed.data) {
              if (!knownIds.has(t.coingeckoId) && !seen.has(t.coingeckoId)) {
                seen.add(t.coingeckoId);
                // First run just baselines the universe without spamming alerts.
                if (!firstRun) {
                  if (await fire(rule.id, null, null,
                    `New tokenized stock listed on CoinGecko: ${t.symbol} (${t.coingeckoId}) — not yet tracked`))
                    fired++;
                }
              }
            }
            await prisma.cacheEntry.upsert({
              where: { key: SEEN_IDS_CACHE_KEY },
              update: { value: JSON.stringify([...seen]), expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000) },
              create: { key: SEEN_IDS_CACHE_KEY, value: JSON.stringify([...seen]), expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000) },
            });
          } catch (e) {
            errors.push(`new_asset discovery: ${e instanceof Error ? e.message : e}`);
          }
          break;
        }
        default:
          errors.push(`unknown rule kind: ${rule.kind}`);
      }
    } catch (e) {
      errors.push(`rule ${rule.id} (${rule.kind}): ${e instanceof Error ? e.message : e}`);
    }
  }

  return { evaluated: rules.length, fired, errors };
}
