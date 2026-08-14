import type { PrismaClient } from '../generated/prisma/client.js';
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import type { Params } from '../types.js';
import { STRATEGY_PROFILES, paramsForProfile, type StrategyProfileSlug } from './profiles.js';

export type PublishedProfileVersion = {
  id: string;
  slug: StrategyProfileSlug;
  version: number;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function strategyParams(baseline: Params, slug: StrategyProfileSlug): Record<string, number> {
  const params = paramsForProfile(baseline, slug);
  const inventoryPolicy = STRATEGY_PROFILES[slug].inventoryPolicy;
  const { widthK, oorDwellMin, edgeOvershootPct, settleMin, costCoverageMultiple } = params;
  return {
    widthK,
    oorDwellMin,
    edgeOvershootPct,
    settleMin,
    costCoverageMultiple,
    deployedBaseShare: inventoryPolicy.deployedBaseShare,
    deployedQuoteShare: inventoryPolicy.deployedQuoteShare,
  };
}

/** Publish immutable built-in versions, creating a new version only when an
 * execution-affecting value changed. Product copy may be corrected in place;
 * parameters, DLMM shape, bin step, and launch guard never are. */
export async function publishBuiltInProfiles(
  prisma: PrismaClient,
  baseline: Params,
): Promise<PublishedProfileVersion[]> {
  const published: PublishedProfileVersion[] = [];

  for (const slug of Object.keys(STRATEGY_PROFILES) as StrategyProfileSlug[]) {
    const definition = STRATEGY_PROFILES[slug];
    const profile = await prisma.strategyProfile.upsert({
      where: { slug },
      create: {
        slug,
        name: definition.name,
        description: `${definition.description} Trade-off: ${definition.tradeoff}`,
      },
      update: {
        name: definition.name,
        description: `${definition.description} Trade-off: ${definition.tradeoff}`,
      },
      select: { id: true },
    });

    const nextParams = strategyParams(baseline, slug);
    const latest = await prisma.strategyProfileVersion.findFirst({
      where: { profileId: profile.id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        paramsJson: true,
        distributionShape: true,
        defaultBinStepBps: true,
        launchGuardHours: true,
      },
    });
    const unchanged =
      latest !== null &&
      canonicalJson(latest.paramsJson) === canonicalJson(nextParams) &&
      latest.distributionShape === definition.distributionShape &&
      latest.defaultBinStepBps === definition.defaultBinStepBps &&
      latest.launchGuardHours === definition.launchGuardHours;

    if (unchanged) {
      published.push({ id: latest.id, slug, version: latest.version });
      continue;
    }

    const created = await prisma.strategyProfileVersion.create({
      data: {
        profileId: profile.id,
        version: (latest?.version ?? 0) + 1,
        paramsJson: nextParams as InputJsonValue,
        distributionShape: definition.distributionShape,
        defaultBinStepBps: definition.defaultBinStepBps,
        launchGuardHours: definition.launchGuardHours,
        note: 'Built-in profile parameters. TODO: validate and tune from launch replay evidence.',
      },
      select: { id: true, version: true },
    });
    published.push({ ...created, slug });
  }

  return published;
}
