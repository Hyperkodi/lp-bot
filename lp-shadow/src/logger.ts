/** Structured-ish stderr logging. Deliberately tiny; no dependency. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function emit(level: Level, message: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra === undefined) {
    console.error(line);
  } else {
    console.error(line, extra);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit('debug', message, extra),
  info: (message: string, extra?: unknown) => emit('info', message, extra),
  warn: (message: string, extra?: unknown) => emit('warn', message, extra),
  error: (message: string, extra?: unknown) => emit('error', message, extra),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
