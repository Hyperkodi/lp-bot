// Divergence & risk monitor: dislocation board, tracking-error leaderboard,
// stale-price flags, concentration warnings.
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getAssetsWithLatestSnapshot } from "@/lib/queries";
import { fmtBps, fmtDateTime } from "@/lib/format";
import { PREMIUM_FLAG_BPS } from "@/lib/metrics/premium";
import { trackingErrorPct } from "@/lib/metrics/tracking-error";

export const dynamic = "force-dynamic";

const STALE_THRESHOLD_MIN = 360; // 6h without a fresh snapshot = stale
const CONCENTRATION_THRESHOLD_PCT = 50; // top-10 holders above this = warning

export default async function RiskMonitor() {
  const assets = await getAssetsWithLatestSnapshot();
  const cutoff30d = new Date(Date.now() - 30 * 24 * 3_600_000);

  // Tracking error per asset over the trailing 30d of snapshots.
  const teRows: { asset: (typeof assets)[number]; te: number; obs: number }[] = [];
  for (const asset of assets) {
    const series = await prisma.assetSnapshot.findMany({
      where: {
        assetId: asset.id,
        takenAt: { gte: cutoff30d },
        tokenPriceUsd: { not: null },
        underlyingPriceUsd: { not: null },
      },
      orderBy: { takenAt: "asc" },
      select: { takenAt: true, tokenPriceUsd: true, underlyingPriceUsd: true },
    });
    const te = trackingErrorPct(
      series.map((s) => ({
        takenAt: s.takenAt,
        tokenPriceUsd: s.tokenPriceUsd as number,
        underlyingPriceUsd: s.underlyingPriceUsd as number,
      })),
    );
    if (te != null) teRows.push({ asset, te, obs: series.length });
  }
  teRows.sort((a, b) => b.te - a.te);

  const dislocations = assets
    .map((a) => ({ asset: a, premium: a.snapshots[0]?.premiumBps ?? null }))
    .filter((r): r is { asset: (typeof assets)[number]; premium: number } => r.premium != null)
    .sort((a, b) => Math.abs(b.premium) - Math.abs(a.premium));

  const stale = assets
    .map((a) => {
      const latest = a.snapshots[0];
      const ageMin = latest ? (Date.now() - latest.takenAt.getTime()) / 60_000 : Infinity;
      return { asset: a, ageMin, hasPrice: latest?.tokenPriceUsd != null };
    })
    .filter((r) => r.ageMin > STALE_THRESHOLD_MIN)
    .sort((a, b) => b.ageMin - a.ageMin);

  const concentration = assets
    .map((a) => ({ asset: a, pct: a.snapshots[0]?.top10HolderPct ?? null }))
    .filter((r): r is { asset: (typeof assets)[number]; pct: number } => r.pct != null && r.pct > CONCENTRATION_THRESHOLD_PCT)
    .sort((a, b) => b.pct - a.pct);

  const panel = (title: string, children: React.ReactNode, accent = false) => (
    <section className={`border bg-terminal-panel ${accent ? "border-terminal-red/50" : "border-terminal-border"}`}>
      <h2 className={`border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider ${accent ? "text-terminal-red" : "text-terminal-muted"}`}>
        {title}
      </h2>
      {children}
    </section>
  );

  const assetLink = (a: (typeof assets)[number]) => (
    <Link href={`/assets/${a.id}`} className="text-terminal-amber hover:underline">{a.symbol}</Link>
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {panel("Largest dislocations (live board)", (
          <table className="w-full text-sm">
            <tbody>
              {dislocations.slice(0, 15).map(({ asset, premium }) => {
                const flagged = Math.abs(premium) > PREMIUM_FLAG_BPS;
                return (
                  <tr key={asset.id} className="border-b border-terminal-border/50 last:border-0">
                    <td className="px-3 py-1.5">{assetLink(asset)}</td>
                    <td className="px-3 py-1.5 text-terminal-muted">{asset.issuer.name.split(" ")[0]}</td>
                    <td className={`px-3 py-1.5 text-right ${flagged ? (premium > 0 ? "text-terminal-green font-bold" : "text-terminal-red font-bold") : "text-terminal-muted"}`}>
                      {fmtBps(premium)}{flagged ? " ⚑" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}

        {panel("Tracking-error leaderboard (30d, per-observation stddev)", teRows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-terminal-muted">
            Needs ≥3 paired token/underlying observations — accumulates as the hourly cron runs.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {teRows.slice(0, 15).map(({ asset, te, obs }) => (
                <tr key={asset.id} className="border-b border-terminal-border/50 last:border-0">
                  <td className="px-3 py-1.5">{assetLink(asset)}</td>
                  <td className="px-3 py-1.5 text-right">{te.toFixed(3)}%</td>
                  <td className="px-3 py-1.5 text-right text-[10px] text-terminal-muted">{obs} obs</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

        {panel(`Stale prices (no snapshot in ${STALE_THRESHOLD_MIN / 60}h)`, stale.length === 0 ? (
          <p className="px-3 py-4 text-xs text-terminal-muted">All tracked assets have fresh snapshots.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {stale.slice(0, 15).map(({ asset, ageMin }) => (
                <tr key={asset.id} className="border-b border-terminal-border/50 last:border-0">
                  <td className="px-3 py-1.5">{assetLink(asset)}</td>
                  <td className="px-3 py-1.5 text-terminal-muted">{asset.issuer.name.split(" ")[0]}</td>
                  <td className="px-3 py-1.5 text-right text-terminal-red">
                    {ageMin === Infinity ? "never" : `${Math.round(ageMin / 60)}h ago`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ), stale.length > 0)}

        {panel(`Holder concentration (top-10 > ${CONCENTRATION_THRESHOLD_PCT}%)`, concentration.length === 0 ? (
          <p className="px-3 py-4 text-xs text-terminal-muted">
            No concentration data yet — top-10 holder share arrives via the Dune adapter (stubbed;
            see src/lib/adapters/dune.ts).
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {concentration.map(({ asset, pct }) => (
                <tr key={asset.id} className="border-b border-terminal-border/50 last:border-0">
                  <td className="px-3 py-1.5">{assetLink(asset)}</td>
                  <td className="px-3 py-1.5 text-right text-terminal-red">{pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ), concentration.length > 0)}
      </div>

      <p className="mt-4 text-[10px] text-terminal-muted">
        Off-hours note: dislocations while NYSE is closed reflect on-chain price discovery, not
        arbitrageable spread — check the marketOpen flag on the asset page. Evaluated{" "}
        {fmtDateTime(new Date())}.
      </p>
    </main>
  );
}
