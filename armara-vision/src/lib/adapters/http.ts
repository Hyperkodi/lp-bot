// Shared HTTP layer for all data-source adapters.
//
// Guarantees the non-functional requirements in one place:
//  - server-side caching with per-call TTL (in-memory, backed by the
//    CacheEntry table so caches survive serverless cold starts)
//  - per-provider rate limiting (min interval between calls)
//  - exponential backoff on 429/5xx/network errors
//  - stale-if-error: if a provider is down and we have an expired cached
//    value, serve it with its "as of" timestamp instead of failing
import { prisma } from "../db";

type CacheHit<T> = { data: T; asOf: Date; stale: boolean };

const memCache = new Map<string, { value: unknown; expiresAt: number; storedAt: number }>();
const lastCallAt = new Map<string, number>();

export interface FetchOptions {
  provider: string; // rate-limit + cache-key namespace, e.g. "coingecko"
  ttlMs: number; // how long a successful response stays fresh
  minIntervalMs?: number; // min spacing between calls to this provider
  headers?: Record<string, string>;
  retries?: number; // backoff attempts (default 3)
  timeoutMs?: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readDbCache(key: string): Promise<{ value: unknown; expiresAt: Date; updatedAt: Date } | null> {
  try {
    const row = await prisma.cacheEntry.findUnique({ where: { key } });
    if (!row) return null;
    return { value: JSON.parse(row.value), expiresAt: row.expiresAt, updatedAt: row.updatedAt };
  } catch {
    return null; // cache table not migrated yet, or db unavailable — never fatal
  }
}

async function writeDbCache(key: string, value: unknown, expiresAt: Date) {
  try {
    await prisma.cacheEntry.upsert({
      where: { key },
      update: { value: JSON.stringify(value), expiresAt },
      create: { key, value: JSON.stringify(value), expiresAt },
    });
  } catch {
    // best-effort
  }
}

async function rateLimit(provider: string, minIntervalMs: number) {
  const last = lastCallAt.get(provider) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(provider, Date.now());
}

/**
 * Cached, rate-limited, retrying JSON GET. Returns the payload plus cache
 * metadata so callers can render "as of" timestamps when serving stale data.
 * Throws only when the provider fails AND no cached copy (fresh or stale)
 * exists — callers should catch and fall back to DB snapshots.
 */
export async function fetchJsonCached<T>(url: string, opts: FetchOptions): Promise<CacheHit<T>> {
  const key = `${opts.provider}:${url}`;
  const now = Date.now();

  const mem = memCache.get(key);
  if (mem && mem.expiresAt > now) {
    return { data: mem.value as T, asOf: new Date(mem.storedAt), stale: false };
  }

  const db = mem ? null : await readDbCache(key);
  if (db && db.expiresAt.getTime() > now) {
    memCache.set(key, { value: db.value, expiresAt: db.expiresAt.getTime(), storedAt: db.updatedAt.getTime() });
    return { data: db.value as T, asOf: db.updatedAt, stale: false };
  }

  const retries = opts.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await rateLimit(opts.provider, opts.minIntervalMs ?? 0);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
      const res = await fetch(url, { headers: opts.headers, signal: ctrl.signal });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${opts.provider} HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
        await sleep(Math.max(retryAfter, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${opts.provider} HTTP ${res.status}: ${await res.text()}`);

      const data = (await res.json()) as T;
      const expiresAt = now + opts.ttlMs;
      memCache.set(key, { value: data, expiresAt, storedAt: now });
      void writeDbCache(key, data, new Date(expiresAt));
      return { data, asOf: new Date(now), stale: false };
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }

  // Provider is down/rate-limited past retries: serve stale if we have it.
  const staleSource = mem ?? (db ? { value: db.value, expiresAt: 0, storedAt: db.updatedAt.getTime() } : null);
  if (staleSource) {
    return { data: staleSource.value as T, asOf: new Date(staleSource.storedAt), stale: true };
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
