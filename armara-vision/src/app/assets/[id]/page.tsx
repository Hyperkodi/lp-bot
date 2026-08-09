// Asset detail: DexScreener-style chart + wallet trading, premium history,
// stats, liquidity by venue, supply changes, and the issuer structure card.
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { fmtUsd, fmtBps, fmtDateTime } from "@/lib/format";
import { PREMIUM_FLAG_BPS } from "@/lib/metrics/premium";
import { trackingErrorPct } from "@/lib/metrics/tracking-error";
import PriceChart from "@/components/PriceChart";
import TradePanel from "@/components/TradePanel";
import PremiumChart from "@/components/PremiumChart";

export const dynamic = "force-dynamic";

export default async function AssetDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await prisma.asset.findUnique({
    where: { id },
    include: {
      issuer: { include: { structure: true } },
      deployments: true,
      snapshots: { orderBy: { takenAt: "desc" }, take: 1 },
    },
  });
  if (!asset) notFound();

  const snap = asset.snapshots[0];
  const premium = snap?.premiumBps ?? null;
  const flagged = premium != null && Math.abs(premium) > PREMIUM_FLAG_BPS;

  const history = await prisma.assetSnapshot.findMany({
    where: { assetId: id, premiumBps: { not: null } },
    orderBy: { takenAt: "asc" },
    take: 1000,
  });
  const premiumPoints = history.map((s) => ({
    time: Math.floor(s.takenAt.getTime() / 1000),
    value: s.premiumBps as number,
    marketOpen: s.marketOpen,
  }));
  const tePct = trackingErrorPct(
    history
      .filter((s) => s.tokenPriceUsd != null && s.underlyingPriceUsd != null)
      .map((s) => ({
        takenAt: s.takenAt,
        tokenPriceUsd: s.tokenPriceUsd as number,
        underlyingPriceUsd: s.underlyingPriceUsd as number,
      })),
  );

  const latestPools = await prisma.poolSnapshot.findMany({
    where: { assetId: id },
    orderBy: { takenAt: "desc" },
    take: 20,
  });
  const newestPoolTime = latestPools[0]?.takenAt?.getTime();
  const pools = latestPools.filter((p) => p.takenAt.getTime() === newestPoolTime);

  const supplyEvents = await prisma.supplyEvent.findMany({
    where: { assetId: id },
    orderBy: { occurredAt: "desc" },
    take: 10,
  });

  const s = asset.issuer.structure;

  const stat = (label: string, value: string, cls = "") => (
    <div className="border border-terminal-border bg-terminal-panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</div>
      <div className={`mt-0.5 text-base ${cls}`}>{value}</div>
    </div>
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl text-terminal-amber">{asset.symbol}</h1>
        <span className="text-sm text-terminal-muted">
          {asset.name} · tracks {asset.underlyingTicker} ({asset.underlyingName})
        </span>
        <span className="text-xs text-terminal-muted">
          {asset.issuer.name} · {asset.deployments.map((d) => d.chain).join(", ")}
        </span>
        <Link href="/assets" className="ml-auto text-xs text-terminal-muted hover:text-terminal-text">
          ← screener
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {stat("Token price", fmtUsd(snap?.tokenPriceUsd))}
        {stat("Underlying", fmtUsd(snap?.underlyingPriceUsd))}
        {stat(
          "Premium/Discount",
          `${fmtBps(premium)}${flagged ? " ⚑" : ""}`,
          premium == null ? "" : flagged ? (premium > 0 ? "text-terminal-green" : "text-terminal-red") : "",
        )}
        {stat("Market cap", fmtUsd(snap?.marketCapUsd, { compact: true }))}
        {stat("Liquidity", fmtUsd(snap?.liquidityUsd, { compact: true }))}
        {stat("Tracking err (per-obs)", tePct != null ? `${tePct.toFixed(3)}%` : "—")}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <PriceChart assetId={asset.id} />
          <section className="border border-terminal-border bg-terminal-panel">
            <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
              Premium / discount history (bps)
            </h2>
            <PremiumChart points={premiumPoints} flagBps={PREMIUM_FLAG_BPS} />
          </section>

          <section className="border border-terminal-border bg-terminal-panel">
            <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
              Liquidity by venue
            </h2>
            {pools.length === 0 ? (
              <p className="px-3 py-4 text-xs text-terminal-muted">
                No pool snapshots yet — populated by the hourly cron once pool discovery has run.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.id} className="border-b border-terminal-border/50 last:border-0">
                      <td className="px-3 py-2">{p.dexName ?? "unknown dex"}</td>
                      <td className="px-3 py-2 text-terminal-muted">{p.chain}</td>
                      <td className="px-3 py-2 text-terminal-muted text-xs">
                        {p.poolAddress.slice(0, 8)}…{p.poolAddress.slice(-4)}
                      </td>
                      <td className="px-3 py-2 text-right">{fmtUsd(p.liquidityUsd, { compact: true })}</td>
                      <td className="px-3 py-2 text-right text-terminal-muted">
                        {fmtUsd(p.volume24hUsd, { compact: true })} vol
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="border border-terminal-border bg-terminal-panel">
            <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
              Supply changes (mint/redeem proxy)
            </h2>
            {supplyEvents.length === 0 ? (
              <p className="px-3 py-4 text-xs text-terminal-muted">
                No supply changes recorded yet — inferred from hourly supply deltas.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {supplyEvents.map((e) => (
                    <tr key={e.id} className="border-b border-terminal-border/50 last:border-0">
                      <td className="px-3 py-2 text-terminal-muted">{fmtDateTime(e.occurredAt)}</td>
                      <td className={`px-3 py-2 text-right ${e.deltaSupply > 0 ? "text-terminal-green" : "text-terminal-red"}`}>
                        {e.deltaSupply > 0 ? "+" : ""}
                        {e.deltaSupply.toLocaleString()} {asset.symbol}
                      </td>
                      <td className="px-3 py-2 text-right text-terminal-muted">{fmtUsd(e.deltaUsd, { compact: true })}</td>
                      <td className="px-3 py-2 text-right text-[10px] text-terminal-muted">{e.kind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <TradePanel assetId={asset.id} symbol={asset.symbol} chains={asset.deployments.map((d) => d.chain)} />

          <section className="border border-terminal-border bg-terminal-panel text-sm">
            <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
              Structure card
            </h2>
            {s ? (
              <dl className="divide-y divide-terminal-border/50">
                {(
                  [
                    ["Legal entity", s.legalEntity],
                    ["Custodian", s.custodian ?? "—"],
                    ["Jurisdiction", s.jurisdiction],
                    ["Backing", s.backingModel.replace(/_/g, " ")],
                    ["Dividends", s.dividendPolicy],
                    ["Redemption", s.redemption],
                    ["Geo restrictions", s.geoRestrictions],
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k} className="px-3 py-2">
                    <dt className="text-[10px] uppercase tracking-wider text-terminal-muted">{k}</dt>
                    <dd className="mt-0.5 text-xs leading-relaxed">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="px-3 py-4 text-xs text-terminal-muted">No structure data seeded for this issuer.</p>
            )}
          </section>

          <p className="text-[10px] text-terminal-muted">
            Snapshot as of {fmtDateTime(snap?.takenAt)} ({snap?.source ?? "—"})
          </p>
        </div>
      </div>
    </main>
  );
}
