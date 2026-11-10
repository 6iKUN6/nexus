import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterSession, AgentEvent } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { type ClaudeAdapterOptions, createClaudeAdapter } from './claudeAdapter';

type Call = { prompt: string; options: Options };
type Script = (call: Call) => AsyncGenerator<unknown>;

/** A stand-in for the SDK's query(): records calls and plays a scripted message stream. */
function fakeQuery(script: Script) {
  const calls: Call[] = [];
  const impl = ((params: { prompt: string; options: Options }) => {
    calls.push(params);
    return script(params);
  }) as unknown as NonNullable<ClaudeAdapterOptions['queryImpl']>;
  return { impl, calls };
}

const sessionOptions = { cwd: '/work', executablePath: '/bin/claude', env: { PATH: '/bin' } };

const text = (t: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } },
});
const result = { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: {} };

async function collect(session: AdapterSession, runId: string, onEvent?: (e: AgentEvent) => void) {
  const events: AgentEvent[] = [];
  for await (const event of session.sendPrompt({ runId, text: 'hi' })) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe('claude adapter session', () => {
  it('starts with a preset session id, then resumes it on the next prompt', async () => {
    const { impl, calls } = fakeQuery(async function* () {
      yield text('ok');
      yield result;
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).createSession(sessionOptions);
    await collect(session, 'r1');
    await collect(session, 'r2');

    expect(calls[0]?.options).toMatchObject({
      sessionId: session.externalId,
      cwd: '/work',
      pathToClaudeCodeExecutable: '/bin/claude',
      permissionMode: 'default',
      includePartialMessages: true,
    });
    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options).toMatchObject({ resume: session.externalId });
    expect(calls[1]?.options.sessionId).toBeUndefined();
  });

  it('resumeSession resumes from the first prompt', async () => {
    const { impl, calls } = fakeQuery(async function* () {
      yield result;
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).resumeSession?.(
      'existing-id',
      sessionOptions,
    );
    if (!session) throw new Error('resumeSession missing');
    await collect(session, 'r1');
    expect(calls[0]?.options.resume).toBe('existing-id');
  });

  it('routes canUseTool to a permission event and waits for the answer', async () => {
    let decision: unknown;
    const { impl } = fakeQuery(async function* ({ options }) {
      const canUseTool = options.canUseTool as CanUseTool;
      decision = await canUseTool(
        'Write',
        { file_path: '/work/a.txt', content: 'hi' },
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_1',
          requestId: 'req',
          suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Write' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
      );
      yield result;
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).createSession(sessionOptions);
    const events = await collect(session, 'r1', (event) => {
      if (event.type === 'permission.requested') {
        expect(event.options.map((o) => o.id)).toEqual([
          'allow_once',
          'allow_always',
          'reject_once',
        ]);
        void session.respondToPermission?.(event.requestId, 'allow_always');
      }
    });
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'permission.requested',
      'usage.updated',
      'run.completed',
    ]);
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules' }],
    });
  });

  it('rejects options that were not offered and unknown requests', async () => {
    const { impl } = fakeQuery(async function* ({ options }) {
      await (options.canUseTool as CanUseTool)(
        'Bash',
        { command: 'ls' },
        {
          signal: new AbortController().signal,
          toolUseID: 't',
          requestId: 'q',
          suppressAlwaysAllowRule: true,
        },
      );
      yield result;
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).createSession(sessionOptions);
    let offered: string[] = [];
    let notOffered: Promise<unknown> = Promise.resolve();
    await collect(session, 'r1', (event) => {
      if (event.type !== 'permission.requested') return;
      offered = event.options.map((o) => o.id);
      notOffered = (
        session.respondToPermission?.(event.requestId, 'allow_always') ?? Promise.resolve()
      ).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      void session.respondToPermission?.(event.requestId, 'reject_once');
    });
    expect(offered).toEqual(['allow_once', 'reject_once']);
    await expect(notOffered).resolves.toMatch(/not offered/);
    await expect(session.respondToPermission?.('nope', 'allow_once')).rejects.toThrow(/Unknown/);
  });

  it('cancels: aborts the SDK, denies pending permissions, ends with cancelled', async () => {
    let decision: unknown;
    const { impl, calls } = fakeQuery(async function* ({ options }) {
      yield text('working');
      decision = await (options.canUseTool as CanUseTool)(
        'Bash',
        { command: 'rm -rf x' },
        {
          signal: new AbortController().signal,
          toolUseID: 't',
          requestId: 'q',
        },
      );
      // A real SDK throws AbortError once aborted.
      if (options.abortController?.signal.aborted) throw new Error('aborted');
      yield result;
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).createSession(sessionOptions);
    const events = await collect(session, 'r1', (event) => {
      if (event.type === 'permission.requested') void session.cancel('r1');
    });
    expect(calls[0]?.options.abortController?.signal.aborted).toBe(true);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(events.at(-1)).toEqual({ type: 'run.completed', runId: 'r1', stopReason: 'cancelled' });
  });

  it('reports a crashing process as run.failed with stderr', async () => {
    const { impl } = fakeQuery(async function* ({ options }) {
      options.stderr?.('Error: not logged in\n');
      yield* [];
      throw new Error('Claude Code process exited with code 1');
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).createSession(sessionOptions);
    const events = await collect(session, 'r1');
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'run.failed', error: { code: 'process_error' } });
    if (last?.type === 'run.failed') expect(last.error.message).toContain('not logged in');
  });

  it('fails fast when no executable was detected', async () => {
    const { impl, calls } = fakeQuery(async function* () {
      yield result;
    });
    const session = await createClaudeAdapter({ queryImpl: impl }).createSession({
      ...sessionOptions,
      executablePath: null,
    });
    const events = await collect(session, 'r1');
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code: 'not_installed' } });
    expect(calls).toHaveLength(0);
  });
});
