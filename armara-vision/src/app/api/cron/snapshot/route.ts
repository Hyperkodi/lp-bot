// Hourly snapshot endpoint. Wire it to a scheduler:
//  - Vercel: crons entry in vercel.json (included) hits this hourly
//  - self-hosted: `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/snapshot`
//    from system cron, or `npm run snapshot`
import { NextRequest, NextResponse } from "next/server";
import { runSnapshot } from "@/lib/snapshot";

export const maxDuration = 300; // provider calls are rate-limited; allow time
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await runSnapshot();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
