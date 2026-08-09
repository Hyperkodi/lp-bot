// Alerts: user-defined rules + firing feed. In-app delivery now; the rule's
// channel field is the seam for email/webhook later.
import Link from "next/link";
import { prisma } from "@/lib/db";
import { fmtDateTime, timeAgo } from "@/lib/format";
import { createRule, toggleRule, deleteRule, acknowledgeEvent } from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, { label: string; unit: string }> = {
  premium_bps: { label: "Premium/discount beyond", unit: "bps" },
  liquidity_drop_pct: { label: "Liquidity drop over 24h beyond", unit: "%" },
  supply_change_pct: { label: "Supply change over 24h beyond", unit: "%" },
  stale_price: { label: "Price stale for more than", unit: "min" },
  new_asset: { label: "New asset listed", unit: "" },
};

export default async function Alerts() {
  const rules = await prisma.alertRule.findMany({ orderBy: { createdAt: "desc" } });
  const events = await prisma.alertEvent.findMany({
    orderBy: { firedAt: "desc" },
    take: 100,
    include: { rule: true },
  });
  const issuers = await prisma.issuer.findMany({ orderBy: { name: "asc" } });
  const assets = await prisma.asset.findMany({ where: { active: true }, orderBy: { symbol: "asc" } });
  const unacked = events.filter((e) => !e.acknowledged);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="border border-terminal-border bg-terminal-panel">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            New alert rule
          </h2>
          <form action={createRule} className="space-y-3 p-3 text-xs">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Condition</span>
              <select name="kind" className="mt-1 w-full border border-terminal-border bg-terminal-bg px-2 py-1.5">
                {Object.entries(KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}{v.unit ? ` X ${v.unit}` : ""}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-terminal-muted">
                Threshold (bps / % / minutes — ignored for new-asset)
              </span>
              <input
                name="threshold" type="number" step="any" placeholder="50"
                className="mt-1 w-full border border-terminal-border bg-terminal-bg px-2 py-1.5"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Asset (optional)</span>
                <select name="assetId" className="mt-1 w-full border border-terminal-border bg-terminal-bg px-2 py-1.5">
                  <option value="">All</option>
                  {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Issuer (optional)</span>
                <select name="issuerId" className="mt-1 w-full border border-terminal-border bg-terminal-bg px-2 py-1.5">
                  <option value="">All</option>
                  {issuers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Name (optional)</span>
              <input name="name" className="mt-1 w-full border border-terminal-border bg-terminal-bg px-2 py-1.5" />
            </label>
            <button className="w-full border border-terminal-amber/60 bg-terminal-bg py-1.5 text-terminal-amber hover:bg-terminal-border">
              CREATE RULE
            </button>
            <p className="text-[10px] leading-relaxed text-terminal-muted">
              Evaluated after each hourly snapshot. 6h cooldown per rule+asset. In-app delivery;
              email/webhook land on the rule&apos;s channel field later.
            </p>
          </form>

          <h2 className="border-y border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Rules ({rules.length})
          </h2>
          <ul className="text-xs">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-terminal-border/50 px-3 py-2 last:border-0">
                <span className={r.enabled ? "" : "text-terminal-muted line-through"}>{r.name}</span>
                <form action={toggleRule} className="ml-auto">
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-terminal-muted hover:text-terminal-amber">{r.enabled ? "PAUSE" : "RESUME"}</button>
                </form>
                <form action={deleteRule}>
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-terminal-muted hover:text-terminal-red">DEL</button>
                </form>
              </li>
            ))}
          </ul>
        </section>

        <section className="border border-terminal-border bg-terminal-panel lg:col-span-2">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Firings {unacked.length > 0 && <span className="text-terminal-amber">({unacked.length} unacknowledged)</span>}
          </h2>
          {events.length === 0 ? (
            <p className="px-3 py-6 text-xs text-terminal-muted">
              Nothing fired yet — rules run after each hourly snapshot (or `npm run snapshot`).
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className={`border-b border-terminal-border/50 align-top last:border-0 ${e.acknowledged ? "text-terminal-muted" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-[10px] text-terminal-muted" title={fmtDateTime(e.firedAt)}>
                      {timeAgo(e.firedAt)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {e.assetId ? (
                        <Link href={`/assets/${e.assetId}`} className="text-terminal-amber hover:underline">
                          {e.message}
                        </Link>
                      ) : e.message}
                      <div className="mt-0.5 text-[10px] text-terminal-muted">{e.rule.name}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {!e.acknowledged && (
                        <form action={acknowledgeEvent}>
                          <input type="hidden" name="id" value={e.id} />
                          <button className="border border-terminal-border px-2 py-0.5 text-[10px] text-terminal-muted hover:border-terminal-amber hover:text-terminal-amber">
                            ACK
                          </button>
                        </form>
                      )}
                    </td>
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
