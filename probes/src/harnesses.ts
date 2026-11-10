import { fileURLToPath } from 'node:url';
import type { HarnessProbe } from './types.ts';

/**
 * Headless invocation for each harness (first probe round).
 * Flags were taken from each CLI's --help on 2026-11-07:
 *   claude 2.1.319, codex-cli 0.154.0, pi 0.84.2. dsh not installed yet.
 * Second round (adapter design) will probe the long-lived protocols:
 * Claude Agent SDK, `codex app-server` JSON-RPC, pi `--mode rpc` / pi-acp.
 */

function pickString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const nested of ['msg', 'event', 'payload', 'params', 'thread']) {
    const found = pickString(record[nested], keys);
    if (found) return found;
  }
  return null;
}

export const HARNESSES: HarnessProbe[] = [
  {
    id: 'claude-code',
    binary: 'claude',
    buildTurnArgs: ({ prompt, sessionId, permissionMode }) => [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(sessionId ? ['--resume', sessionId] : []),
      // "none": anything that would prompt is auto-denied, so we observe the denial event.
      ...(permissionMode === 'none' ? ['--permission-prompts', 'none'] : []),
    ],
    findSessionId: (json) => pickString(json, ['session_id', 'sessionId']),
    helpCommands: [['--version'], ['--help']],
  },
  {
    id: 'codex',
    binary: 'codex',
    buildTurnArgs: ({ prompt, sessionId, cwd }) =>
      sessionId
        ? ['exec', '--json', '--skip-git-repo-check', '-C', cwd, 'resume', sessionId, prompt]
        : ['exec', '--json', '--skip-git-repo-check', '-C', cwd, prompt],
    findSessionId: (json) => pickString(json, ['thread_id', 'threadId', 'session_id', 'sessionId']),
    helpCommands: [
      ['--version'],
      ['exec', '--help'],
      ['exec', 'resume', '--help'],
      ['app-server', '--help'],
    ],
    notes:
      'Native adapter target is `codex app-server`; run `codex app-server generate-ts --out <dir>` for the protocol.',
  },
  {
    id: 'pi',
    binary: 'pi',
    // pi lets us choose the session id, so resume does not depend on parsing output.
    buildTurnArgs: ({ prompt, presetSessionId }) => [
      '-p',
      '--mode',
      'json',
      '--session-id',
      presetSessionId,
      prompt,
    ],
    findSessionId: (json, turn) =>
      pickString(json, ['sessionId', 'session_id', 'id']) ?? turn.presetSessionId,
    helpCommands: [['--version'], ['--help']],
    notes: 'Also probe `pi --mode rpc` and `npx -y pi-acp` (what AionCore uses).',
  },
  {
    id: 'dsh',
    binary: 'dsh',
    // Unknown until installed: fill in after reading `dsh --help`.
    buildTurnArgs: () => null,
    findSessionId: (json) => pickString(json, ['session_id', 'sessionId']),
    helpCommands: [['--version'], ['--help']],
    notes: 'Install DeepSeek Harness, run the help scenario, then define buildTurnArgs.',
  },
];

/** Pseudo harness that exercises the runner (cancel escalation, orphans, resume) for free. */
HARNESSES.push({
  id: 'selftest',
  binary: process.execPath,
  hidden: true,
  buildTurnArgs: ({ prompt, sessionId }) => [
    fileURLToPath(new URL('../fixtures/selftest-harness.mjs', import.meta.url)),
    ...(sessionId ? ['--resume', sessionId] : []),
    prompt,
  ],
  findSessionId: (json) => pickString(json, ['session_id']),
  helpCommands: [['--version']],
});

export function findHarness(id: string): HarnessProbe | undefined {
  return HARNESSES.find((h) => h.id === id);
}
