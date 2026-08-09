// Market overview: totals, issuer breakdown, chain footprint, dislocations.
import Link from "next/link";
import { getAssetsWithLatestSnapshot } from "@/lib/queries";
import { fmtUsd, fmtBps, fmtDateTime } from "@/lib/format";
import { PREMIUM_FLAG_BPS } from "@/lib/metrics/premium";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const assets = await getAssetsWithLatestSnapshot();

  const latest = (a: (typeof assets)[number]) => a.snapshots[0];
  const totalValue = assets.reduce((s, a) => s + (latest(a)?.marketCapUsd ?? 0), 0);
  const totalVolume = assets.reduce((s, a) => s + (latest(a)?.volume24hUsd ?? 0), 0);
  const dislocated = assets.filter((a) => {
    const p = latest(a)?.premiumBps;
    return p != null && Math.abs(p) > PREMIUM_FLAG_BPS;
  });
  const asOf = assets
    .map((a) => latest(a)?.takenAt)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const byIssuer = new Map<string, { name: string; value: number; count: number }>();
  for (const a of assets) {
    const row = byIssuer.get(a.issuerId) ?? { name: a.issuer.name, value: 0, count: 0 };
    row.value += latest(a)?.marketCapUsd ?? 0;
    row.count += 1;
    byIssuer.set(a.issuerId, row);
  }

  const byChain = new Map<string, number>();
  for (const a of assets) {
    for (const d of a.deployments) byChain.set(d.chain, (byChain.get(d.chain) ?? 0) + 1);
  }

  const stat = (label: string, value: string, accent = false) => (
    <div className="border border-terminal-border bg-terminal-panel p-4">
      <div className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</div>
      <div className={`mt-1 text-xl ${accent ? "text-terminal-amber" : ""}`}>{value}</div>
    </div>
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat("Tracked on-chain equity value", fmtUsd(totalValue || null, { compact: true }), true)}
        {stat("24h reported volume", fmtUsd(totalVolume || null, { compact: true }))}
        {stat("Tracked assets", String(assets.length))}
        {stat(`Dislocations > ±${PREMIUM_FLAG_BPS}bps`, String(dislocated.length))}
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section className="border border-terminal-border bg-terminal-panel">
          <h2 className="border-b border-terminal-border px-4 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Value by issuer
          </h2>
          <table className="w-full text-sm">
            <tbody>
              {[...byIssuer.entries()]
                .sort((a, b) => b[1].value - a[1].value)
                .map(([id, r]) => (
                  <tr key={id} className="border-b border-terminal-border/50 last:border-0">
                    <td className="px-4 py-2">{r.name}</td>
                    <td className="px-4 py-2 text-right text-terminal-muted">{r.count} assets</td>
                    <td className="px-4 py-2 text-right">{fmtUsd(r.value || null, { compact: true })}</td>
                    <td className="px-4 py-2 text-right text-terminal-muted">
                      {totalValue > 0 ? `${((r.value / totalValue) * 100).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section className="border border-terminal-border bg-terminal-panel">
          <h2 className="border-b border-terminal-border px-4 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Largest live dislocations
          </h2>
          {dislocated.length === 0 ? (
            <p className="px-4 py-6 text-sm text-terminal-muted">
              No premium/discount beyond ±{PREMIUM_FLAG_BPS}bps in the latest snapshot.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {dislocated
                  .sort((a, b) => Math.abs(latest(b)?.premiumBps ?? 0) - Math.abs(latest(a)?.premiumBps ?? 0))
                  .slice(0, 8)
                  .map((a) => {
                    const p = latest(a)?.premiumBps ?? 0;
                    return (
                      <tr key={a.id} className="border-b border-terminal-border/50 last:border-0">
                        <td className="px-4 py-2">
                          <Link href={`/assets/${a.id}`} className="text-terminal-amber hover:underline">
                            {a.symbol}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-terminal-muted">{a.issuer.name}</td>
                        <td className={`px-4 py-2 text-right ${p > 0 ? "text-terminal-green" : "text-terminal-red"}`}>
                          {fmtBps(p)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
          <div className="border-t border-terminal-border px-4 py-2 text-[10px] text-terminal-muted">
            Chain footprint:{" "}
            {[...byChain.entries()].map(([c, n]) => `${c} (${n})`).join(" · ")}
          </div>
        </section>
      </div>

      <p className="mt-4 text-[10px] text-terminal-muted">
        Data as of {fmtDateTime(asOf)} — cached snapshots; hourly cron refresh.
      </p>
    </main>
  );
}
