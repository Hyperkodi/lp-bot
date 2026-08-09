// Seeds issuers (+ structure cards), the top ~35 tracked tokenized equities,
// and the manual event log. Also writes one "seed" AssetSnapshot per asset
// with indicative prices so the UI renders meaningfully before any live API
// call succeeds. Idempotent: safe to re-run (upserts).
import { PrismaClient } from "@prisma/client";
import issuers from "./seed-data/issuers.json";
import assets from "./seed-data/assets.json";
import events from "./seed-data/events.json";

const prisma = new PrismaClient();

// Indicative underlying prices (late-2025 ballpark) used only for the "seed"
// snapshot so first render isn't blank. Replaced by live data on first cron run.
const INDICATIVE_PRICE: Record<string, number> = {
  AAPL: 270, TSLA: 430, NVDA: 185, MSFT: 480, AMZN: 230, GOOGL: 310,
  META: 640, SPY: 680, QQQ: 610, CRCL: 85, COIN: 270, HOOD: 120,
  MSTR: 180, AVGO: 350, LLY: 1050, JPM: 300, V: 340, WMT: 105,
  NFLX: 110, PLTR: 170, GLD: 380, AMD: 210,
};

async function main() {
  for (const i of issuers) {
    const { structure, ...issuer } = i as any;
    await prisma.issuer.upsert({
      where: { id: issuer.id },
      update: issuer,
      create: issuer,
    });
    if (structure) {
      await prisma.structureProfile.upsert({
        where: { issuerId: issuer.id },
        update: structure,
        create: { issuerId: issuer.id, ...structure },
      });
    }
  }

  for (const a of assets) {
    const { chains, ...asset } = a as any;
    await prisma.asset.upsert({
      where: { id: asset.id },
      update: asset,
      create: asset,
    });
    for (const chain of chains as string[]) {
      await prisma.assetDeployment.upsert({
        where: { assetId_chain: { assetId: asset.id, chain } },
        update: {},
        create: {
          assetId: asset.id,
          chain,
          // TODO: fill verified contract addresses per chain; resolved lazily
          // from GeckoTerminal token search until then.
          address: null,
          geckoTerminalNetwork: chain === "bnb" ? "bsc" : chain === "ethereum" ? "eth" : chain,
        },
      });
    }

    // One indicative snapshot so screener/dashboard render before live data.
    const px = INDICATIVE_PRICE[asset.underlyingTicker] ?? 100;
    const existing = await prisma.assetSnapshot.findFirst({
      where: { assetId: asset.id, source: "seed" },
    });
    if (!existing) {
      await prisma.assetSnapshot.create({
        data: {
          assetId: asset.id,
          takenAt: new Date(),
          tokenPriceUsd: px * 1.001, // nominal +10bps so premium logic is visibly exercised
          underlyingPriceUsd: px,
          premiumBps: 10,
          marketOpen: false,
          source: "seed",
        },
      });
    }
  }

  for (const e of events) {
    const exists = await prisma.eventLog.findFirst({ where: { title: e.title } });
    if (!exists) {
      await prisma.eventLog.create({
        data: { ...e, date: new Date(e.date) },
      });
    }
  }

  // A couple of sensible default alert rules so the alerts UI isn't empty.
  const defaultRules = [
    { name: "Premium/discount beyond 50bps (any asset)", kind: "premium_bps", threshold: 50 },
    { name: "Stale on-chain price > 6h", kind: "stale_price", threshold: 360 },
    { name: "New asset listed", kind: "new_asset", threshold: null as number | null },
  ];
  for (const r of defaultRules) {
    const exists = await prisma.alertRule.findFirst({ where: { name: r.name } });
    if (!exists) await prisma.alertRule.create({ data: r });
  }

  const counts = {
    issuers: await prisma.issuer.count(),
    assets: await prisma.asset.count(),
    deployments: await prisma.assetDeployment.count(),
    events: await prisma.eventLog.count(),
  };
  console.log("Seed complete:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
