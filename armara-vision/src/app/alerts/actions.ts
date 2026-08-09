"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";

const KINDS = new Set(["premium_bps", "liquidity_drop_pct", "supply_change_pct", "stale_price", "new_asset"]);

export async function createRule(formData: FormData) {
  const kind = String(formData.get("kind") ?? "");
  if (!KINDS.has(kind)) return;
  const thresholdRaw = formData.get("threshold");
  const threshold = kind === "new_asset" || thresholdRaw === "" || thresholdRaw == null ? null : Number(thresholdRaw);
  if (threshold != null && !Number.isFinite(threshold)) return;
  const assetId = String(formData.get("assetId") ?? "") || null;
  const issuerId = String(formData.get("issuerId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim() || defaultName(kind, threshold, assetId, issuerId);

  await prisma.alertRule.create({ data: { name, kind, threshold, assetId, issuerId } });
  revalidatePath("/alerts");
}

function defaultName(kind: string, threshold: number | null, assetId: string | null, issuerId: string | null): string {
  const scope = assetId ?? issuerId ?? "all assets";
  switch (kind) {
    case "premium_bps": return `Premium/discount > ±${threshold ?? 50}bps (${scope})`;
    case "liquidity_drop_pct": return `Liquidity drop > ${threshold ?? 25}% / 24h (${scope})`;
    case "supply_change_pct": return `Supply change > ±${threshold ?? 10}% / 24h (${scope})`;
    case "stale_price": return `Price stale > ${threshold ?? 360}min (${scope})`;
    default: return `New asset listed (${scope})`;
  }
}

export async function toggleRule(formData: FormData) {
  const id = Number(formData.get("id"));
  const rule = await prisma.alertRule.findUnique({ where: { id } });
  if (!rule) return;
  await prisma.alertRule.update({ where: { id }, data: { enabled: !rule.enabled } });
  revalidatePath("/alerts");
}

export async function deleteRule(formData: FormData) {
  const id = Number(formData.get("id"));
  await prisma.alertEvent.deleteMany({ where: { ruleId: id } });
  await prisma.alertRule.delete({ where: { id } }).catch(() => {});
  revalidatePath("/alerts");
}

export async function acknowledgeEvent(formData: FormData) {
  const id = Number(formData.get("id"));
  await prisma.alertEvent.update({ where: { id }, data: { acknowledged: true } }).catch(() => {});
  revalidatePath("/alerts");
}
