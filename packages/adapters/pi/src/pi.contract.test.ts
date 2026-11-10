import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nexus/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createPiAdapter } from './piAdapter';

/**
 * Contract test against the REAL pi CLI (`pi --mode rpc`). Spends model
 * quota, so it is excluded from `pnpm test`; run with `pnpm test:contract`.
 * Requires: `pi` on PATH and a configured provider.
 * Verified with the developer's pi (2026-11, rpc recordings in fixtures/).
 */

const executablePath = process.env.NEXUS_PI_PATH ?? findOnPath('pi');
const cwd = mkdtempSync(join(tmpdir(), 'nexus-pi-contract-'));
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

describe.runIf(executablePath)('pi contract (real CLI)', () => {
  it('streams a reply and keeps session context on the next prompt', async () => {
    const session = await createPiAdapter().createSession({ cwd, executablePath, env });
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

  it('cancels mid-run via abort and ends cancelled', async () => {
    const session = await createPiAdapter().createSession({ cwd, executablePath, env });
    const events: AgentEvent[] = [];
    for await (const e of session.sendPrompt({
      runId: 'r1',
      text: 'Count from 1 to 400, one number per line, no commentary.',
    })) {
      events.push(e);
      if (events.filter((x) => x.type === 'text.delta').length === 3) await session.cancel('r1');
    }
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'cancelled' });
    await session.dispose();
  }, 180_000);

  it('a resumed session still has the context', async () => {
    const first = await createPiAdapter().createSession({ cwd, executablePath, env });
    for await (const e of first.sendPrompt({
      runId: 'r1',
      text: 'Remember the code word CRIMSON-42. Reply with OK only.',
    })) {
      if (e.type === 'run.failed') throw new Error(e.error.message);
    }
    await first.dispose();

    const adapter = createPiAdapter();
    const resume = adapter.resumeSession?.bind(adapter);
    if (!resume) throw new Error('adapter is missing resumeSession');
    const resumed = await resume(first.externalId, { cwd, executablePath, env });
    let reply = '';
    for await (const e of resumed.sendPrompt({
      runId: 'r2',
      text: 'What was the code word? Reply with it only.',
    })) {
      if (e.type === 'text.delta') reply += e.text;
      if (e.type === 'run.failed') throw new Error(e.error.message);
    }
    expect(reply).toContain('CRIMSON-42');
    await resumed.dispose();
  }, 180_000);
});
