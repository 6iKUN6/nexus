import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nexus/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createClaudeAdapter } from './claudeAdapter';

/**
 * Contract test against the REAL Claude Code CLI. Spends model quota, so it
 * is excluded from `pnpm test`; run with `pnpm test:contract`.
 * Requires: `claude` on PATH and logged in. Pinned/verified with 2.1.319.
 */

const executablePath = process.env.NEXUS_CLAUDE_PATH ?? findOnPath('claude');
const cwd = mkdtempSync(join(tmpdir(), 'nexus-contract-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

describe.runIf(executablePath)('Claude Code contract (real CLI)', () => {
  it('streams a reply and resumes the same session on the next prompt', async () => {
    const session = await createClaudeAdapter().createSession({ cwd, executablePath, env });
    const first: AgentEvent[] = [];
    for await (const e of session.sendPrompt({
      runId: 'r1',
      text: 'Remember the code word AZURE-17. Reply with OK only.',
    })) {
      first.push(e);
    }
    expect(first.at(-1)).toMatchObject({ type: 'run.completed' });
    expect(first.some((e) => e.type === 'text.delta')).toBe(true);

    let reply = '';
    for await (const e of session.sendPrompt({
      runId: 'r2',
      text: 'What was the code word? Reply with it only.',
    })) {
      if (e.type === 'text.delta') reply += e.text;
      if (e.type === 'run.failed') throw new Error(e.error.message);
    }
    expect(reply).toContain('AZURE-17');
    await session.dispose();
  }, 180_000);

  it('asks before writing, and a rejection leaves the file system untouched', async () => {
    const session = await createClaudeAdapter().createSession({ cwd, executablePath, env });
    const events: AgentEvent[] = [];
    for await (const e of session.sendPrompt({
      runId: 'r1',
      text: 'Create a file named created.txt in the current directory containing the text hi.',
    })) {
      events.push(e);
      if (e.type === 'permission.requested')
        await session.respondToPermission?.(e.requestId, 'reject_once');
    }
    expect(events.some((e) => e.type === 'permission.requested')).toBe(true);
    expect(existsSync(join(cwd, 'created.txt'))).toBe(false);
    expect(['run.completed', 'run.failed']).toContain(events.at(-1)?.type);
    await session.dispose();
  }, 180_000);

  it('cancels mid-run and ends with a cancelled terminal event', async () => {
    const session = await createClaudeAdapter().createSession({ cwd, executablePath, env });
    const events: AgentEvent[] = [];
    for await (const e of session.sendPrompt({
      runId: 'r1',
      text: 'Count from 1 to 400, one number per line.',
    })) {
      events.push(e);
      if (events.filter((x) => x.type === 'text.delta').length === 3) await session.cancel('r1');
    }
    expect(events.at(-1)).toEqual({ type: 'run.completed', runId: 'r1', stopReason: 'cancelled' });
    await session.dispose();
  }, 180_000);
});
