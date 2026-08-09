// Asset screener: every tracked tokenized stock with the premium/discount
// column front and center. Filters/sort via query params (server-rendered).
import Link from "next/link";
import { getAssetsWithLatestSnapshot } from "@/lib/queries";
import { fmtUsd, fmtBps, fmtDateTime } from "@/lib/format";
import { PREMIUM_FLAG_BPS } from "@/lib/metrics/premium";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Search = { issuer?: string; chain?: string; sector?: string; sort?: string; dislocated?: string };

const SORTS: Record<string, (a: Row, b: Row) => number> = {
  premium: (a, b) => Math.abs(b.premium ?? 0) - Math.abs(a.premium ?? 0),
  mcap: (a, b) => (b.snap?.marketCapUsd ?? 0) - (a.snap?.marketCapUsd ?? 0),
  volume: (a, b) => (b.snap?.volume24hUsd ?? 0) - (a.snap?.volume24hUsd ?? 0),
  liquidity: (a, b) => (b.snap?.liquidityUsd ?? 0) - (a.snap?.liquidityUsd ?? 0),
  symbol: (a, b) => a.asset.symbol.localeCompare(b.asset.symbol),
};

type Row = {
  asset: Awaited<ReturnType<typeof getAssetsWithLatestSnapshot>>[number];
  snap: Awaited<ReturnType<typeof getAssetsWithLatestSnapshot>>[number]["snapshots"][number] | undefined;
  premium: number | null;
};

export default async function Screener({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const assets = await getAssetsWithLatestSnapshot();
  const issuers = await prisma.issuer.findMany({ orderBy: { name: "asc" } });
  const sectors = [...new Set(assets.map((a) => a.sector).filter((s): s is string => !!s))].sort();
  const chains = [...new Set(assets.flatMap((a) => a.deployments.map((d) => d.chain)))].sort();

  let rows: Row[] = assets.map((asset) => {
    const snap = asset.snapshots[0];
    return { asset, snap, premium: snap?.premiumBps ?? null };
  });

  if (params.issuer) rows = rows.filter((r) => r.asset.issuerId === params.issuer);
  if (params.chain) rows = rows.filter((r) => r.asset.deployments.some((d) => d.chain === params.chain));
  if (params.sector) rows = rows.filter((r) => r.asset.sector === params.sector);
  if (params.dislocated) rows = rows.filter((r) => r.premium != null && Math.abs(r.premium) > PREMIUM_FLAG_BPS);
  rows.sort(SORTS[params.sort ?? "mcap"] ?? SORTS.mcap);

  const asOf = rows.map((r) => r.snap?.takenAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];

  const sortLink = (key: string, label: string) => {
    const q = new URLSearchParams({ ...params, sort: key } as Record<string, string>);
    return (
      <Link href={`/assets?${q}`} className="hover:text-terminal-text">
        {label}{(params.sort ?? "mcap") === key ? " ▾" : ""}
      </Link>
    );
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <form className="mb-4 flex flex-wrap items-end gap-3 text-xs" method="GET">
        {[
          { name: "issuer", label: "Issuer", options: issuers.map((i) => [i.id, i.name]) },
          { name: "chain", label: "Chain", options: chains.map((c) => [c, c]) },
          { name: "sector", label: "Sector", options: sectors.map((s) => [s, s]) },
        ].map((f) => (
          <label key={f.name} className="flex flex-col gap-1">
            <span className="text-terminal-muted uppercase tracking-wider text-[10px]">{f.label}</span>
            <select
              name={f.name}
              defaultValue={(params as Record<string, string | undefined>)[f.name] ?? ""}
              className="border border-terminal-border bg-terminal-panel px-2 py-1"
            >
              <option value="">All</option>
              {f.options.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        ))}
        <label className="flex items-center gap-2 pb-1">
          <input type="checkbox" name="dislocated" value="1" defaultChecked={!!params.dislocated} />
          <span className="text-terminal-muted">&gt; ±{PREMIUM_FLAG_BPS}bps only</span>
        </label>
        <button className="border border-terminal-border bg-terminal-panel px-3 py-1 hover:border-terminal-amber">
          APPLY
        </button>
      </form>

      <div className="overflow-x-auto border border-terminal-border bg-terminal-panel">
        <table className="w-full whitespace-nowrap text-sm">
          <thead>
            <tr className="border-b border-terminal-border text-left text-[10px] uppercase tracking-wider text-terminal-muted">
              <th className="px-3 py-2">{sortLink("symbol", "Token")}</th>
              <th className="px-3 py-2">Underlying</th>
              <th className="px-3 py-2">Issuer</th>
              <th className="px-3 py-2">Chains</th>
              <th className="px-3 py-2 text-right">Token px</th>
              <th className="px-3 py-2 text-right">Equity px</th>
              <th className="px-3 py-2 text-right">{sortLink("premium", "Prem/Disc")}</th>
              <th className="px-3 py-2 text-right">{sortLink("mcap", "Mkt cap")}</th>
              <th className="px-3 py-2 text-right">{sortLink("volume", "24h vol")}</th>
              <th className="px-3 py-2 text-right">{sortLink("liquidity", "Liquidity")}</th>
              <th className="px-3 py-2 text-right">Slip $100k</th>
              <th className="px-3 py-2 text-right">Slip $1M</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ asset, snap, premium }) => {
              const flagged = premium != null && Math.abs(premium) > PREMIUM_FLAG_BPS;
              return (
                <tr key={asset.id} className="border-b border-terminal-border/50 last:border-0 hover:bg-terminal-bg/60">
                  <td className="px-3 py-2">
                    <Link href={`/assets/${asset.id}`} className="text-terminal-amber hover:underline">
                      {asset.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-terminal-muted">{asset.underlyingTicker}</td>
                  <td className="px-3 py-2 text-terminal-muted">{asset.issuer.name.split(" ")[0]}</td>
                  <td className="px-3 py-2 text-terminal-muted">
                    {asset.deployments.map((d) => d.chain).join(", ")}
                  </td>
                  <td className="px-3 py-2 text-right">{fmtUsd(snap?.tokenPriceUsd)}</td>
                  <td className="px-3 py-2 text-right">{fmtUsd(snap?.underlyingPriceUsd)}</td>
                  <td
                    className={`px-3 py-2 text-right ${
                      premium == null
                        ? "text-terminal-muted"
                        : flagged
                          ? premium > 0 ? "text-terminal-green font-bold" : "text-terminal-red font-bold"
                          : ""
                    }`}
                  >
                    {fmtBps(premium)}{flagged ? " ⚑" : ""}
                  </td>
                  <td className="px-3 py-2 text-right">{fmtUsd(snap?.marketCapUsd, { compact: true })}</td>
                  <td className="px-3 py-2 text-right">{fmtUsd(snap?.volume24hUsd, { compact: true })}</td>
                  <td className="px-3 py-2 text-right">{fmtUsd(snap?.liquidityUsd, { compact: true })}</td>
                  <td className="px-3 py-2 text-right">{fmtBps(snap?.slippage100kBps)}</td>
                  <td className="px-3 py-2 text-right">{fmtBps(snap?.slippage1mBps)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[10px] text-terminal-muted">
        {rows.length} assets · data as of {fmtDateTime(asOf)} · slippage is an AMM screening estimate, not an
        execution quote
      </p>
    </main>
  );
}
