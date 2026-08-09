// Shared read-side queries: assets joined with their most recent snapshot.
// Snapshot-first by design — pages render from stored data (with its "as of"
// timestamp), never blocking on live provider calls.
import { prisma } from "./db";

export type AssetWithLatest = Awaited<ReturnType<typeof getAssetsWithLatestSnapshot>>[number];

export async function getAssetsWithLatestSnapshot() {
  return prisma.asset.findMany({
    where: { active: true },
    include: {
      issuer: true,
      deployments: true,
      snapshots: { orderBy: { takenAt: "desc" }, take: 1 },
    },
    orderBy: { symbol: "asc" },
  });
}

/** Change vs the closest snapshot at least `hours` old, as a %. */
export async function getChangePct(assetId: string, hours: number): Promise<number | null> {
  const latest = await prisma.assetSnapshot.findFirst({
    where: { assetId, tokenPriceUsd: { not: null } },
    orderBy: { takenAt: "desc" },
  });
  if (!latest?.tokenPriceUsd) return null;
  const cutoff = new Date(latest.takenAt.getTime() - hours * 3_600_000);
  const past = await prisma.assetSnapshot.findFirst({
    where: { assetId, tokenPriceUsd: { not: null }, takenAt: { lte: cutoff } },
    orderBy: { takenAt: "desc" },
  });
  if (!past?.tokenPriceUsd) return null;
  return (latest.tokenPriceUsd / past.tokenPriceUsd - 1) * 100;
}
