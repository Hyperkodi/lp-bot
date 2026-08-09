// Temporary status page — replaced by the market overview dashboard in build
// step 3 (pending schema sign-off). Verifies DB, seed data, and snapshots
// end-to-end.
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [issuers, assets, deployments, snapshots, latest] = await Promise.all([
    prisma.issuer.count(),
    prisma.asset.count(),
    prisma.assetDeployment.count(),
    prisma.assetSnapshot.count(),
    prisma.assetSnapshot.findFirst({ orderBy: { takenAt: "desc" } }),
  ]);

  const rows: [string, string][] = [
    ["Issuers", String(issuers)],
    ["Tracked assets", String(assets)],
    ["Chain deployments", String(deployments)],
    ["Snapshots stored", String(snapshots)],
    ["Latest snapshot", latest ? `${latest.takenAt.toISOString()} (${latest.source})` : "—"],
  ];

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="border border-terminal-border bg-terminal-panel p-6">
        <h1 className="text-terminal-amber text-lg tracking-widest uppercase">
          Armara Vision
        </h1>
        <p className="mt-1 text-terminal-muted text-sm">
          Tokenized equities — institutional analytics &amp; monitoring
        </p>
        <div className="mt-6 divide-y divide-terminal-border border-t border-b border-terminal-border">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between py-2 text-sm">
              <span className="text-terminal-muted">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <p className="mt-6 text-terminal-muted text-xs">
          Scaffold status page — market overview dashboard ships in build step 3.
        </p>
      </div>
    </main>
  );
}
