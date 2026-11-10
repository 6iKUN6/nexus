import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterSession, AgentEvent } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { createPiAdapter } from './piAdapter';

/**
 * Replays a sanitized `pi --mode rpc` recording (fixtures/*.jsonl): extension
 * noise is emitted at spawn (the adapter must ignore it), command responses
 * echo the incoming id, and the prompt command triggers the recorded event
 * stream.
 */

type WireMessage = Record<string, unknown>;

/** A spawnImpl that always returns the same fake child. */
const spawnReturning = (child: ChildProcess) =>
  (() => child) as unknown as typeof import('node:child_process').spawn;

function fakePiProcess(fixture: string) {
  const outLines = readFileSync(join(import.meta.dirname, '../fixtures', fixture), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; msg: WireMessage })
    .filter((r) => r.dir === 'out')
    .map((r) => r.msg);

  // Startup noise precedes the get_state response in the recording.
  const stateIndex = outLines.findIndex((m) => m.type === 'response' && m.command === 'get_state');
  const startupNoise = outLines.slice(0, stateIndex);
  const stateResponse = outLines[stateIndex] as WireMessage;
  const afterState = outLines.slice(stateIndex + 1);

  const stdinLines: WireMessage[] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();

  // Macrotask pacing lets the consumer keep up (microtasks would let the
  // replay finish a whole run before cancel() can land mid-stream).
  const emit = (msg: WireMessage) =>
    setTimeout(() => stdout.emit('data', `${JSON.stringify(msg)}\n`), 0);

  const child = {
    pid: 4343,
    stdin: {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as WireMessage;
          stdinLines.push(msg);
          if (msg.type === 'get_state') {
            emit({ ...stateResponse, id: msg.id });
          } else if (msg.type === 'prompt') {
            for (const out of afterState) {
              if (out.type === 'response') emit({ ...out, id: msg.id });
              else emit(out);
            }
          }
          // abort and everything else: pi answers nothing (per the recording).
        }
        return true;
      },
    },
    stdout: Object.assign(stdout, { setEncoding: () => {} }),
    stderr: Object.assign(stderr, { setEncoding: () => {} }),
    on: emitter.on.bind(emitter),
    kill: () => {},
  } as unknown as ChildProcess;

  for (const noise of startupNoise) emit(noise);
  return { child, stdinLines };
}

const sessionOptions = { cwd: '/work', executablePath: '/bin/pi', env: { PATH: '/bin' } };

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

describe('pi adapter session', () => {
  it('maps a basic run: thinking, text, usage, terminal event', async () => {
    const { child } = fakePiProcess('rpc-basic.jsonl');
    const adapter = createPiAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);

    const events = await collect(session, 'r1');
    expect(events[0]).toEqual({ type: 'run.started', runId: 'r1' });
    const thinking = events
      .filter((e) => e.type === 'thinking.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(thinking).toBe('Need final exactly OK.');
    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('OK');
    expect(events.find((e) => e.type === 'usage.updated')).toMatchObject({
      inputTokens: 5972,
      outputTokens: 22,
      estimated: false,
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' });
    // No permission events exist for pi (it has no permission gating).
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
  });

  it('maps tool execution start/end to tool cards', async () => {
    const { child } = fakePiProcess('rpc-write.jsonl');
    const adapter = createPiAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);

    const events = await collect(session, 'r1');
    const start = events.find((e) => e.type === 'tool.started');
    expect(start).toMatchObject({
      name: 'write',
      toolCallId: 'tool_PjelcpICZWCdFzfoVPt8nLXa',
      input: { path: 'hello.txt', content: 'hi' },
    });
    const end = events.find((e) => e.type === 'tool.completed');
    expect(end).toMatchObject({
      toolCallId: 'tool_PjelcpICZWCdFzfoVPt8nLXa',
      status: 'ok',
      summary: 'Successfully wrote 2 bytes to hello.txt',
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' });
  });

  it('maps abort to a cancelled terminal event', async () => {
    const { child, stdinLines } = fakePiProcess('rpc-abort.jsonl');
    const adapter = createPiAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);

    let cancelled = false;
    const events = await collect(session, 'r1', (event) => {
      if (!cancelled && event.type === 'text.delta') {
        cancelled = true;
        void session.cancel('r1');
      }
    });

    expect(stdinLines.some((m) => m.type === 'abort')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'cancelled' });
  });

  it('ignores a late agent_settled from the previous run (seen against real pi)', async () => {
    // Real pi emits agent_settled for run 1 AFTER run 2's prompt was sent;
    // it must not terminate run 2. Scripted child for this exact sequence.
    const stdout = new EventEmitter();
    const emitter = new EventEmitter();
    const emit = (msg: WireMessage) =>
      setTimeout(() => stdout.emit('data', `${JSON.stringify(msg)}\n`), 0);
    let prompts = 0;
    const child = {
      pid: 4444,
      stdin: {
        write(chunk: string) {
          const msg = JSON.parse(chunk.trim()) as WireMessage;
          if (msg.type === 'get_state') {
            emit({ id: msg.id, type: 'response', command: 'get_state', success: true, data: {} });
          } else if (msg.type === 'prompt') {
            prompts++;
            emit({ id: msg.id, type: 'response', command: 'prompt', success: true });
            if (prompts === 1) {
              emit({ type: 'agent_start' });
              emit({ type: 'agent_end', messages: [] });
            } else {
              // The straggler from run 1, then run 2's real stream.
              emit({ type: 'agent_settled' });
              emit({ type: 'agent_start' });
              emit({
                type: 'message_update',
                message: {},
                assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'AZURE-17' },
              });
              emit({
                type: 'turn_end',
                message: { role: 'assistant', stopReason: 'stop', content: [] },
              });
              emit({ type: 'agent_end', messages: [] });
            }
          }
          return true;
        },
      },
      stdout: Object.assign(stdout, { setEncoding: () => {} }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
      on: emitter.on.bind(emitter),
      kill: () => {},
    } as unknown as ChildProcess;

    const adapter = createPiAdapter({ spawnImpl: spawnReturning(child) });
    const session = await adapter.createSession(sessionOptions);
    await collect(session, 'r1');
    const events = await collect(session, 'r2');

    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('AZURE-17');
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' });
  });

  it('spawns with --session-id so a resume re-attaches to the same pi session', async () => {
    const { child } = fakePiProcess('rpc-basic.jsonl');
    const spawnArgs: string[][] = [];
    const spawnImpl = ((_exe: string, args: string[]) => {
      spawnArgs.push(args);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const adapter = createPiAdapter({ spawnImpl });

    const created = await adapter.createSession(sessionOptions);
    expect(created.externalId).toBeTruthy();
    expect(spawnArgs[0]).toEqual(['--mode', 'rpc', '--session-id', created.externalId]);

    const resume = adapter.resumeSession?.bind(adapter);
    if (!resume) throw new Error('adapter is missing resumeSession');
    const resumed = await resume('session-abc', sessionOptions);
    expect(resumed.externalId).toBe('session-abc');
    expect(spawnArgs[1]).toEqual(['--mode', 'rpc', '--session-id', 'session-abc']);
  });
});
