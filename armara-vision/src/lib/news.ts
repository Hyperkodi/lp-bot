// News service: pull RSS feeds, keep only tokenization-relevant items, tag
// them by issuer and by "upcoming" (announced-but-not-launched tokenizations),
// persist to NewsItem. Called from the hourly snapshot job.
import { prisma } from "./db";
import { FEED_SOURCES, fetchFeed } from "./adapters/rss";

// An item is relevant if it matches any of these.
const TOPIC_KEYWORDS = [
  "tokenized", "tokenization", "tokenised", "tokenisation",
  "rwa", "real-world asset", "real world asset",
  "on-chain stock", "onchain stock", "stock token", "equity token",
  "xstock", "dshare", "tokenized equit",
];

// "Upcoming" = announcements of future launches/listings.
const UPCOMING_KEYWORDS = [
  "to launch", "will launch", "plans to", "to tokenize", "to tokenise",
  "announces", "upcoming", "to list", "will list", "set to", "preparing",
  "roadmap", "coming to", "to offer", "files for", "applies for", "to bring",
];

const ISSUER_KEYWORDS: Record<string, string[]> = {
  xstocks: ["xstocks", "backed finance", "kraken"],
  ondo: ["ondo"],
  bstocks: ["binance"],
  dinari: ["dinari", "dshares"],
  "robinhood-eu": ["robinhood"],
  securitize: ["securitize"],
};

function matchAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function classifyTitle(title: string): { relevant: boolean; upcoming: boolean; issuerTags: string[] } {
  const relevant = matchAny(title, TOPIC_KEYWORDS) ||
    Object.values(ISSUER_KEYWORDS).some((ks) => matchAny(title, ks));
  const upcoming = matchAny(title, UPCOMING_KEYWORDS);
  const issuerTags = Object.entries(ISSUER_KEYWORDS)
    .filter(([, ks]) => matchAny(title, ks))
    .map(([slug]) => slug);
  return { relevant, upcoming, issuerTags };
}

export interface NewsRefreshResult {
  fetched: number;
  storedNew: number;
  errors: string[];
}

export async function refreshNews(): Promise<NewsRefreshResult> {
  let fetched = 0;
  let storedNew = 0;
  const errors: string[] = [];

  for (const source of FEED_SOURCES) {
    try {
      const items = await fetchFeed(source);
      fetched += items.length;
      for (const item of items) {
        const { relevant, upcoming, issuerTags } = classifyTitle(item.title);
        if (!relevant) continue;
        const tags = [...issuerTags, ...(upcoming ? ["upcoming"] : [])].join(",");
        const created = await prisma.newsItem.upsert({
          where: { url: item.url },
          update: {}, // never rewrite an already-stored item
          create: {
            source: item.source,
            title: item.title,
            url: item.url,
            publishedAt: item.publishedAt,
            issuerTags: tags || null,
          },
        });
        if (Math.abs(created.fetchedAt.getTime() - Date.now()) < 5000) storedNew++;
      }
    } catch (e) {
      errors.push(`${source.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { fetched, storedNew, errors };
}
