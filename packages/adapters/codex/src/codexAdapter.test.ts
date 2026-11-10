import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterSession, AgentEvent } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';

/**
 * Replays a sanitized app-server recording (fixtures/*.jsonl) against the
 * adapter: fixture responses are emitted only after the adapter writes the
 * matching request, and server-initiated approval requests pause the replay
 * until the adapter answers — so tests exercise the real wire timing.
 */

type WireMessage = Record<string, unknown>;

/** A spawnImpl that always returns the same fake child. */
const spawnReturning = (child: ChildProcess) =>
  (() => child) as unknown as typeof import('node:child_process').spawn;

function fakeCodexProcess(fixture: string) {
  const outLines = readFileSync(join(import.meta.dirname, '../fixtures', fixture), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; msg: WireMessage })
    .filter((r) => r.dir === 'out')
    .map((r) => r.msg);

  const stdinLines: WireMessage[] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  let index = 0;
  const seenRequests = new Set<number>();
  let waitingForServerResponse: number | string | null = null;

  const emit = (msg: WireMessage) => stdout.emit('data', `${JSON.stringify(msg)}\n`);

  const pump = () => {
    while (index < outLines.length) {
      const msg = outLines[index] as WireMessage;
      const isResponse = msg.method === undefined && typeof msg.id === 'number';
      const isServerRequest = typeof msg.method === 'string' && msg.id !== undefined;
      if (isResponse && !seenRequests.has(msg.id as number)) return; // wait for our request
      index++;
      emit(msg);
      if (isServerRequest) {
        waitingForServerResponse = msg.id as number | string;
        return; // wait for respondToPermission
      }
    }
  };

  const child = {
    // No real process: stop() reports the spawn as gone immediately.
    pid: undefined,
    stdin: {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as WireMessage;
          stdinLines.push(msg);
          if (typeof msg.method === 'string' && typeof msg.id === 'number') {
            seenRequests.add(msg.id);
            // The adapter finished its call; the fixture response can flow.
            queueMicrotask(pump);
          } else if (msg.id !== undefined && waitingForServerResponse === msg.id) {
            waitingForServerResponse = null;
            queueMicrotask(pump);
          }
        }
        return true;
      },
    },
    stdout: Object.assign(stdout, { setEncoding: () => {} }),
    stderr: Object.assign(stderr, { setEncoding: () => {} }),
    on: emitter.on.bind(emitter),
    kill: () => {},
  } as unknown as ChildProcess;

  return { child, stdinLines };
}

const sessionOptions = { cwd: '/work', executablePath: '/bin/codex', env: { PATH: '/bin' } };

async function collect(
  session: AdapterSession,
  runId: string,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.sendPrompt({ runId, text: 'hi' })) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe('codex adapter session', () => {
  it('starts a thread and maps the basic turn (text, usage, duration)', async () => {
    const { child } = fakeCodexProcess('appserver-basic.jsonl');
    const adapter = createCodexAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);
    expect(session.externalId).toBe('01a1c429-f55d-73d3-bcd5-2ef04ca71b77');

    const events = await collect(session, 'r1');
    expect(events[0]).toEqual({ type: 'run.started', runId: 'r1' });
    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('OK');
    expect(events.find((e) => e.type === 'usage.updated')).toMatchObject({
      inputTokens: 26840,
      outputTokens: 6,
      estimated: false,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed',
      stopReason: 'end_turn',
      durationMs: 25128,
    });
  });

  it('turns an approval request into a permission card and answers accept', async () => {
    const { child, stdinLines } = fakeCodexProcess('appserver-approval.jsonl');
    const adapter = createCodexAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);

    const respond = session.respondToPermission?.bind(session);
    if (!respond) throw new Error('session is missing respondToPermission');
    const events = await collect(session, 'r1', (event) => {
      if (event.type === 'permission.requested') {
        void respond(event.requestId, 'allow_once');
      }
    });

    const permission = events.find((e) => e.type === 'permission.requested');
    expect(permission).toMatchObject({
      requestId: 'codex-0',
      toolCallId: 'exec-042fa6f4-8a14-456a-aa96-2cab9ef45aa8',
      description: "/bin/zsh -lc 'printf %s hello-from-codex > note.txt'",
    });
    // The adapter answered the server request with the mapped decision.
    const answer = stdinLines.find((m) => m.id === 0 && m.method === undefined);
    expect(answer).toMatchObject({ result: { decision: 'accept' } });

    const toolStart = events.find((e) => e.type === 'tool.started');
    expect(toolStart).toMatchObject({ name: '终端命令' });
    const toolEnd = events.find((e) => e.type === 'tool.completed');
    expect(toolEnd).toMatchObject({ status: 'ok' });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' });
  });

  it('maps cancel to turn/interrupt and ends with stopReason cancelled', async () => {
    const { child, stdinLines } = fakeCodexProcess('appserver-interrupt.jsonl');
    const adapter = createCodexAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);

    let cancelled = false;
    const events = await collect(session, 'r1', (event) => {
      if (!cancelled && event.type === 'text.delta') {
        cancelled = true;
        void session.cancel('r1');
      }
    });

    const interrupt = stdinLines.find((m) => m.method === 'turn/interrupt');
    expect(interrupt).toMatchObject({
      params: {
        threadId: '01a1c42a-99f4-7be1-991b-e406f2b9b781',
        turnId: '01a1c42a-9a62-7660-ab50-755a5e60e0ec',
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'cancelled' });
  });

  it('resumes a thread by id and emits text that only arrives on item/completed', async () => {
    const { child, stdinLines } = fakeCodexProcess('appserver-resume.jsonl');
    const adapter = createCodexAdapter({ spawnImpl: spawnReturning(child) });
    const resume = adapter.resumeSession?.bind(adapter);
    if (!resume) throw new Error('adapter is missing resumeSession');
    const session = await resume('01a1c429-f55d-73d3-bcd5-2ef04ca71b77', sessionOptions);
    expect(stdinLines.find((m) => m.method === 'thread/resume')).toMatchObject({
      params: { threadId: '01a1c429-f55d-73d3-bcd5-2ef04ca71b77', excludeTurns: true },
    });

    const events = await collect(session, 'r1');
    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toContain('OK');
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' });
  });

  it('pins the approval policy instead of inheriting a permissive config', async () => {
    const { child, stdinLines } = fakeCodexProcess('appserver-basic.jsonl');
    const adapter = createCodexAdapter({ spawnImpl: spawnReturning(child) });
    await adapter.createSession(sessionOptions);
    expect(stdinLines.find((m) => m.method === 'thread/start')).toMatchObject({
      params: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    });
  });
});
