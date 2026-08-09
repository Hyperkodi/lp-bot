// News & events: upcoming tokenizations first (announced-but-not-launched),
// then the full RWA-filtered feed and the manual regulatory event log.
// Feed items arrive via the hourly cron (refreshNews); seed items fill the
// panel until then.
import { prisma } from "@/lib/db";
import { fmtDateTime, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const ISSUER_LABELS: Record<string, string> = {
  xstocks: "xStocks",
  ondo: "Ondo",
  bstocks: "bStocks",
  dinari: "Dinari",
  "robinhood-eu": "Robinhood EU",
  securitize: "Securitize",
};

export default async function News({ searchParams }: { searchParams: Promise<{ issuer?: string }> }) {
  const { issuer } = await searchParams;

  const all = await prisma.newsItem.findMany({
    orderBy: { publishedAt: "desc" },
    take: 200,
  });
  const filtered = issuer ? all.filter((n) => n.issuerTags?.split(",").includes(issuer)) : all;
  const upcoming = filtered.filter((n) => n.issuerTags?.split(",").includes("upcoming"));
  const rest = filtered.filter((n) => !n.issuerTags?.split(",").includes("upcoming"));

  const events = await prisma.eventLog.findMany({ orderBy: { date: "desc" }, take: 30, include: { issuer: true } });

  const tagChips = (tags: string | null) =>
    (tags ?? "")
      .split(",")
      .filter((t) => t && t !== "upcoming")
      .map((t) => (
        <span key={t} className="ml-2 border border-terminal-border px-1 py-0.5 text-[9px] uppercase text-terminal-muted">
          {ISSUER_LABELS[t] ?? t}
        </span>
      ));

  const newsRow = (n: (typeof all)[number]) => (
    <li key={n.id} className="border-b border-terminal-border/50 px-3 py-2 last:border-0">
      <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-sm hover:text-terminal-amber">
        {n.title}
      </a>
      {tagChips(n.issuerTags)}
      <div className="mt-0.5 text-[10px] text-terminal-muted">
        {n.source} · {timeAgo(n.publishedAt)}
      </div>
    </li>
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <form method="GET" className="mb-4 flex items-end gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-terminal-muted">Filter by issuer</span>
          <select name="issuer" defaultValue={issuer ?? ""} className="border border-terminal-border bg-terminal-panel px-2 py-1">
            <option value="">All issuers</option>
            {Object.entries(ISSUER_LABELS).map(([slug, label]) => (
              <option key={slug} value={slug}>{label}</option>
            ))}
          </select>
        </label>
        <button className="border border-terminal-border bg-terminal-panel px-3 py-1 hover:border-terminal-amber">APPLY</button>
        <span className="ml-auto pb-1 text-[10px] text-terminal-muted">
          Sources: Ledger Insights · Blockworks · CoinDesk (hourly refresh, keyword-filtered)
        </span>
      </form>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="border border-terminal-amber/40 bg-terminal-panel lg:col-span-1">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-amber">
            Upcoming tokenizations
          </h2>
          {upcoming.length === 0 ? (
            <p className="px-3 py-4 text-xs text-terminal-muted">No upcoming-launch items match this filter.</p>
          ) : (
            <ul>{upcoming.map(newsRow)}</ul>
          )}
          <p className="border-t border-terminal-border px-3 py-2 text-[10px] text-terminal-muted">
            Auto-tagged from launch/announcement language in headlines.
          </p>
        </section>

        <section className="border border-terminal-border bg-terminal-panel lg:col-span-2">
          <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
            Tokenization news
          </h2>
          {rest.length === 0 ? (
            <p className="px-3 py-4 text-xs text-terminal-muted">No items yet — feed refresh runs with the hourly cron.</p>
          ) : (
            <ul>{rest.map(newsRow)}</ul>
          )}
        </section>
      </div>

      <section className="mt-4 border border-terminal-border bg-terminal-panel">
        <h2 className="border-b border-terminal-border px-3 py-2 text-xs uppercase tracking-wider text-terminal-muted">
          Regulatory & market-structure event log
        </h2>
        <table className="w-full text-sm">
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-terminal-border/50 align-top last:border-0">
                <td className="whitespace-nowrap px-3 py-2 text-terminal-muted">{fmtDateTime(e.date).slice(0, 10)}</td>
                <td className="px-3 py-2">
                  <span className="text-terminal-text">{e.title}</span>
                  <p className="mt-0.5 text-xs text-terminal-muted">{e.description}</p>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[10px] uppercase text-terminal-muted">
                  {e.kind}{e.issuer ? ` · ${e.issuer.name.split(" ")[0]}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
