// Flows & activity: net mint/redeem by issuer, chain volume-share migration,
// whale watch (pending Dune/RPC wiring). Charts are server-rendered SVG —
// robust with the sparse data of a young snapshot history.
import { prisma } from "@/lib/db";
import { fmtUsd } from "@/lib/format";
import { getWhaleTransfers } from "@/lib/adapters/dune";

export const dynamic = "force-dynamic";

const ISSUER_COLORS: Record<string, string> = {
  xstocks: "#e8a33d",
  ondo: "#34d399",
  bstocks: "#fbbf24",
  dinari: "#60a5fa",
  "robinhood-eu": "#a78bfa",
  securitize: "#f87171",
};
const CHAIN_COLORS: Record<string, string> = {
  solana: "#a78bfa",
  ethereum: "#60a5fa",
  bnb: "#fbbf24",
  arbitrum: "#38bdf8",
  base: "#3b82f6",
};

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function Flows() {
  // --- Net supply flow by issuer per day (USD) ---
  const supplyEvents = await prisma.supplyEvent.findMany({
    include: { asset: { select: { issuerId: true } } },
    orderBy: { occurredAt: "asc" },
  });
  const flowByDay = new Map<string, Map<string, number>>();
  for (const e of supplyEvents) {
    if (e.deltaUsd == null) continue;
    const day = dayKey(e.occurredAt);
    const m = flowByDay.get(day) ?? new Map<string, number>();
    m.set(e.asset.issuerId, (m.get(e.asset.issuerId) ?? 0) + e.deltaUsd);
    flowByDay.set(day, m);
  }
  const flowDays = [...flowByDay.keys()].sort().slice(-30);

  // --- Chain volume share per day (from pool snapshots) ---
  const poolSnaps = await prisma.poolSnapshot.findMany({
    orderBy: { takenAt: "asc" },
    select: { chain: true, takenAt: true, volume24hUsd: true },
  });
  const volByDay = new Map<string, Map<string, number>>();
  for (const p of poolSnaps) {
    if (p.volume24hUsd == null) continue;
    const day = dayKey(p.takenAt);
    const m = volByDay.get(day) ?? new Map<string, number>();
    m.set(p.chain, (m.get(p.chain) ?? 0) + p.volume24hUsd);
    volByDay.set(day, m);
  }
  const volDays = [...volByDay.keys()].sort().slice(-30);

  let whales: Awaited<ReturnType<typeof getWhaleTransfers>> = [];
  try {
    whales = await getWhaleTransfers();
  } catch {
    whales = [];
  }

  // Shared SVG bar geometry
  const W = 720, H = 200, MID = H / 2;
  const maxAbsFlow = Math.max(
    1,
    ...flowDays.map((d) => {
      const m = flowByDay.get(d)!;
      const pos = [...m.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
      const neg = [...m.values()].filter((v) => v < 0).reduce((a, b) => a - b, 0);
      return Math.max(pos, neg);
    }),
  );
  const barW = Math.max(4, Math.floor(W / Math.max(flowDays.length, 1)) - 3);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="space-y-4">
        <section className="border border-terminal-border bg-terminal-panel">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Net supply flow by issuer (USD/day — are institutions minting or redeeming?)
          </h2>
          {flowDays.length === 0 ? (
            <p className="px-3 py-6 text-xs text-terminal-muted">
              No supply events yet — inferred from hourly supply deltas once live snapshots accumulate.
            </p>
          ) : (
            <div className="overflow-x-auto p-3">
              <svg width={W} height={H}>
                <line x1={0} y1={MID} x2={W} y2={MID} stroke="#1c2433" />
                {flowDays.map((d, i) => {
                  const m = flowByDay.get(d)!;
                  let upOffset = 0, downOffset = 0;
                  return [...m.entries()].map(([issuer, v]) => {
                    const h = (Math.abs(v) / maxAbsFlow) * (MID - 10);
                    const x = i * (barW + 3);
                    let y;
                    if (v >= 0) { y = MID - upOffset - h; upOffset += h; }
                    else { y = MID + downOffset; downOffset += h; }
                    return (
                      <rect key={`${d}-${issuer}`} x={x} y={y} width={barW} height={Math.max(h, 0.5)}
                        fill={ISSUER_COLORS[issuer] ?? "#64748b"} opacity={v >= 0 ? 0.9 : 0.6}>
                        <title>{`${d} ${issuer}: ${fmtUsd(v, { compact: true })}`}</title>
                      </rect>
                    );
                  });
                })}
              </svg>
              <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-terminal-muted">
                {Object.entries(ISSUER_COLORS).map(([k, c]) => (
                  <span key={k}><span style={{ color: c }}>■</span> {k}</span>
                ))}
                <span className="ml-auto">above line = net mint · below = net redeem</span>
              </div>
            </div>
          )}
        </section>

        <section className="border border-terminal-border bg-terminal-panel">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Chain migration — DEX volume share by chain
          </h2>
          {volDays.length === 0 ? (
            <p className="px-3 py-6 text-xs text-terminal-muted">
              No pool volume history yet — populated once pool discovery runs in the hourly cron.
            </p>
          ) : (
            <div className="overflow-x-auto p-3">
              <svg width={W} height={140}>
                {volDays.map((d, i) => {
                  const m = volByDay.get(d)!;
                  const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
                  let offset = 0;
                  const x = i * (barW + 3);
                  return [...m.entries()].map(([chain, v]) => {
                    const h = (v / total) * 120;
                    const y = 130 - offset - h;
                    offset += h;
                    return (
                      <rect key={`${d}-${chain}`} x={x} y={y} width={barW} height={Math.max(h, 0.5)}
                        fill={CHAIN_COLORS[chain] ?? "#64748b"}>
                        <title>{`${d} ${chain}: ${((v / total) * 100).toFixed(1)}% (${fmtUsd(v, { compact: true })})`}</title>
                      </rect>
                    );
                  });
                })}
              </svg>
              <div className="mt-2 flex gap-3 text-[10px] text-terminal-muted">
                {Object.entries(CHAIN_COLORS).map(([k, c]) => (
                  <span key={k}><span style={{ color: c }}>■</span> {k}</span>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="border border-terminal-border bg-terminal-panel">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Whale watch — largest on-chain transfers (24h)
          </h2>
          {whales.length === 0 ? (
            <p className="px-3 py-6 text-xs text-terminal-muted">
              Pending data source: large-transfer feed arrives with the Dune adapter (or direct RPC
              log scanning) — stubbed in src/lib/adapters/dune.ts with the query plan.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {whales.map((w) => (
                  <tr key={w.txHash} className="border-b border-terminal-border/50 last:border-0">
                    <td className="px-3 py-2">{w.tokenSymbol}</td>
                    <td className="px-3 py-2 text-terminal-muted">{w.chain}</td>
                    <td className="px-3 py-2 text-right">{fmtUsd(w.amountUsd, { compact: true })}</td>
                    <td className="px-3 py-2 text-[10px] text-terminal-muted">{w.txHash.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
