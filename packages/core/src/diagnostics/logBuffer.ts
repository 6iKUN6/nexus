import { format } from 'node:util';

/**
 * In packaged builds there is no terminal watching stderr, so console output
 * is simply lost. This tees console.error/warn into a small ring buffer that
 * the diagnostic export can attach. Deliberately a tee (not a logger
 * refactor): existing call sites stay untouched.
 */

const MAX_LINES = 500;
const lines: string[] = [];
let installed = false;

function push(args: unknown[]): void {
  const line = `${new Date().toISOString()} ${format(...args)}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const level of ['error', 'warn'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      push(args);
      original.apply(console, args);
    };
  }
}

/** Test hook: clears the buffer so tests do not leak lines into each other. */
export function resetLogCapture(): void {
  lines.length = 0;
}

export function recentLogs(): string {
  return lines.join('\n');
}
