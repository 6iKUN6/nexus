import { type AgentEvent, agentEventSchema } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeStep } from './fakeAdapter';

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function session(script?: FakeStep[], stepDelayMs = 0) {
  const adapter = createFakeAdapter({
    ...(script ? { script } : {}),
    stepDelayMs,
  });
  return adapter.createSession({ cwd: '/tmp', executablePath: null, env: {} });
}

describe('fake adapter', () => {
  it('streams schema-valid events ending in exactly one terminal event', async () => {
    const s = await session();
    const events = await collect(
      s.sendPrompt({ runId: 'r1', text: '你好，世界，这是一个比较长的提示' }),
    );

    for (const event of events) expect(agentEventSchema.parse(event)).toEqual(event);
    expect(events[0]).toEqual({ type: 'run.started', runId: 'r1' });
    expect(events.at(-1)).toEqual({ type: 'run.completed', runId: 'r1', stopReason: 'end_turn' });
    const text = events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
    expect(text).toBe('收到：你好，世界，这是一个比较长的提示');
    expect(
      events.filter((e) => e.type === 'run.completed' || e.type === 'run.failed'),
    ).toHaveLength(1);
  });

  it('pairs tool.started with tool.completed', async () => {
    const s = await session([
      { kind: 'tool', name: 'grep', input: { q: 'x' }, summary: '3 matches' },
    ]);
    const events = await collect(s.sendPrompt({ runId: 'r1', text: '' }));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['run.started', 'tool.started', 'tool.completed', 'run.completed']);
  });

  it('emits thinking deltas and nests scripted child tools under their parent', async () => {
    const s = await session([
      { kind: 'thinking', text: '想一下' },
      {
        kind: 'tool',
        name: 'Task',
        input: { description: '子任务' },
        summary: '完成',
        children: [{ name: 'Glob', input: { pattern: '*.ts' }, summary: '2 个文件' }],
      },
    ]);
    const events = await collect(s.sendPrompt({ runId: 'r1', text: '' }));
    for (const event of events) expect(agentEventSchema.parse(event)).toEqual(event);
    expect(events[1]).toEqual({ type: 'thinking.delta', runId: 'r1', text: '想一下' });
    const child = events.find((e) => e.type === 'tool.started' && e.name === 'Glob');
    expect(child).toMatchObject({ parentToolCallId: 'r1-tool-0' });
  });

  it('blocks on a permission request until it is answered', async () => {
    const s = await session([
      { kind: 'permission', description: '写入 a.txt' },
      { kind: 'text', text: 'done' },
    ]);
    const iterator = s.sendPrompt({ runId: 'r1', text: '' })[Symbol.asyncIterator]();
    await iterator.next(); // run.started
    const request = (await iterator.next()).value as AgentEvent;
    expect(request.type).toBe('permission.requested');
    if (request.type !== 'permission.requested') return;

    const next = iterator.next();
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await s.respondToPermission?.(request.requestId, 'allow');
    expect((await next).value).toMatchObject({ type: 'text.delta', text: 'done' });
    await expect(s.respondToPermission?.(request.requestId, 'allow')).rejects.toThrow(/expired/);
  });

  it('ends with stopReason refused when permission is rejected', async () => {
    const s = await session([
      { kind: 'permission', description: 'rm -rf build' },
      { kind: 'text', text: 'never' },
    ]);
    const events: AgentEvent[] = [];
    for await (const event of s.sendPrompt({ runId: 'r1', text: '' })) {
      events.push(event);
      if (event.type === 'permission.requested')
        await s.respondToPermission?.(event.requestId, 'reject');
    }
    expect(events.at(-1)).toEqual({ type: 'run.completed', runId: 'r1', stopReason: 'refused' });
    expect(events.some((e) => e.type === 'text.delta')).toBe(false);
  });

  it('cancels a run while it waits for permission', async () => {
    const s = await session([{ kind: 'permission', description: 'x' }]);
    const events: AgentEvent[] = [];
    for await (const event of s.sendPrompt({ runId: 'r1', text: '' })) {
      events.push(event);
      if (event.type === 'permission.requested') await s.cancel('r1');
    }
    expect(events.at(-1)).toEqual({ type: 'run.completed', runId: 'r1', stopReason: 'cancelled' });
  });

  it('cancels a slow run mid-stream', async () => {
    const s = await session(
      Array.from({ length: 50 }, () => ({ kind: 'text' as const, text: '.' })),
      5,
    );
    const events: AgentEvent[] = [];
    for await (const event of s.sendPrompt({ runId: 'r1', text: '' })) {
      events.push(event);
      if (events.length === 3) await s.cancel('r1');
    }
    expect(events.length).toBeLessThan(10);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'cancelled' });
  });

  it('reports scripted failures as run.failed', async () => {
    const s = await session([{ kind: 'fail', code: 'auth', message: 'not logged in' }]);
    const events = await collect(s.sendPrompt({ runId: 'r1', text: '' }));
    expect(events.at(-1)).toEqual({
      type: 'run.failed',
      runId: 'r1',
      error: { code: 'auth', message: 'not logged in' },
    });
  });

  it('refuses a second concurrent run on the same session', async () => {
    const s = await session([{ kind: 'permission', description: 'x' }]);
    const first = s.sendPrompt({ runId: 'r1', text: '' })[Symbol.asyncIterator]();
    await first.next();
    await expect(collect(s.sendPrompt({ runId: 'r2', text: '' }))).rejects.toThrow(
      /already in progress/,
    );
    await s.dispose();
  });
});
