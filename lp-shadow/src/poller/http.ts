/** Shared fetch helpers: timeouts, JSON decoding, no retries-on-a-loop. */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(
        `${init.method ?? 'GET'} ${url} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
