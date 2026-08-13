/**
 * The only place the process is allowed to reason about wall-clock time zones.
 * Kept out of decision/ and virtual/ on purpose — those layers never read a
 * clock, they read `snapshot.ts`.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Local hour (0-23) in `timeZone` for an epoch-ms instant. */
export function localHour(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(ts));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(hour) % 24;
}

/** `YYYY-MM-DD` in `timeZone`; used as the "already reported today" cursor. */
export function localDayKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

/** ISO week key, so the go-live gate is printed once a week. */
export function isWeeklyReportDay(ts: number, timeZone: string): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(ts),
  );
  return weekday === 'Mon';
}
