// RSS/Atom feed adapter for RWA-focused news. Dependency-free parser that
// handles the common RSS 2.0 / Atom shapes these publishers use.

export interface FeedSource {
  id: string;
  name: string;
  url: string;
}

// Feeds are fetched server-side only. CoinDesk's RWA tag has no dedicated
// feed, so we take the main feed and rely on keyword filtering below.
export const FEED_SOURCES: FeedSource[] = [
  { id: "ledgerinsights", name: "Ledger Insights", url: "https://www.ledgerinsights.com/feed/" },
  { id: "blockworks", name: "Blockworks", url: "https://blockworks.co/feed" },
  { id: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
];

export interface FeedItem {
  source: string;
  title: string;
  url: string;
  publishedAt: Date;
}

function textBetween(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function parseFeed(xml: string, sourceName: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const title = textBetween(block, "title");
    // RSS: <link>url</link>; Atom: <link href="url"/>
    let url = textBetween(block, "link");
    if (!url) url = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null;
    const dateStr =
      textBetween(block, "pubDate") ?? textBetween(block, "published") ?? textBetween(block, "updated");
    if (!title || !url) continue;
    const publishedAt = dateStr ? new Date(dateStr) : new Date();
    if (Number.isNaN(publishedAt.getTime())) continue;
    items.push({ source: sourceName, title, url, publishedAt });
  }
  return items;
}

/** Fetch and parse one feed. Caching happens at the NewsItem table level —
 *  items are persisted and feeds re-read hourly by the cron. */
export async function fetchFeed(source: FeedSource): Promise<FeedItem[]> {
  const res = await fetch(source.url, {
    headers: { "user-agent": "ArmaraVision/0.1 (RWA analytics; contact: repo issues)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${source.id} HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml, source.name);
}
