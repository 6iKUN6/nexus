import type { ConversationEvent, ConversationEventBody, PermissionOption } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './buildTimeline';

function log(...bodies: ConversationEventBody[]): ConversationEvent[] {
  return bodies.map((body, i) => ({ conversationId: 'c', seq: i + 1, at: 1000 + i, body }));
}

const allow: PermissionOption = { id: 'allow_once', label: '允许一次', kind: 'allow_once' };
const reject: PermissionOption = { id: 'reject_once', label: '拒绝', kind: 'reject_once' };

describe('buildTimeline', () => {
  it('merges deltas into one bubble and splits it around tool calls', () => {
    const { items } = buildTimeline(
      log(
        { type: 'user.message', messageId: 'm1', text: 'hi' },
        { type: 'run.started', runId: 'r1' },
        { type: 'text.delta', runId: 'r1', text: '先' },
        { type: 'text.delta', runId: 'r1', text: '看看' },
        {
          type: 'tool.started',
          runId: 'r1',
          toolCallId: 't1',
          name: 'Read',
          input: { file_path: 'a.ts' },
        },
        { type: 'tool.completed', runId: 'r1', toolCallId: 't1', status: 'ok', summary: '12 行' },
        { type: 'text.delta', runId: 'r1', text: '好了' },
        { type: 'run.completed', runId: 'r1', stopReason: 'end_turn' },
      ),
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'agent', 'tool', 'agent']);
    expect(items[1]).toMatchObject({ text: '先看看', streaming: false });
    expect(items[2]).toMatchObject({ name: 'Read', detail: 'a.ts', status: 'ok', output: '12 行' });
    expect(items[3]).toMatchObject({ text: '好了', streaming: false });
  });

  it('keeps the last bubble streaming while the run is active', () => {
    const { items, runs } = buildTimeline(
      log({ type: 'run.started', runId: 'r1' }, { type: 'text.delta', runId: 'r1', text: '…' }),
    );
    expect(items[0]).toMatchObject({ kind: 'agent', streaming: true });
    expect(runs[0]?.outcome).toBe('running');
  });

  it('tracks permission resolution and expires unanswered prompts when the run ends', () => {
    const request = (requestId: string): ConversationEventBody => ({
      type: 'permission.requested',
      runId: 'r1',
      requestId,
      toolCallId: null,
      description: '写入 a.txt',
      options: [allow, reject],
    });
    const { items } = buildTimeline(
      log(
        { type: 'run.started', runId: 'r1' },
        request('p1'),
        { type: 'permission.resolved', runId: 'r1', requestId: 'p1', optionId: 'reject_once' },
        request('p2'),
        { type: 'run.completed', runId: 'r1', stopReason: 'cancelled' },
      ),
    );
    expect(items[0]).toMatchObject({ kind: 'permission', state: 'resolved', chosen: reject });
    expect(items[1]).toMatchObject({ kind: 'permission', state: 'expired', chosen: null });
    expect(items[2]).toMatchObject({ kind: 'system', text: '你停止了这次运行' });
  });

  it('marks an unfinished tool as unknown (not ok) when the run fails', () => {
    const { items, runs } = buildTimeline(
      log(
        { type: 'run.started', runId: 'r1' },
        {
          type: 'tool.started',
          runId: 'r1',
          toolCallId: 't1',
          name: 'Bash',
          input: { command: 'make' },
        },
        { type: 'run.failed', runId: 'r1', error: { code: 'interrupted', message: '中断' } },
      ),
    );
    expect(items[0]).toMatchObject({ kind: 'tool', status: 'unknown' });
    expect(items[1]).toMatchObject({ kind: 'failure', code: 'interrupted' });
    expect(runs[0]).toMatchObject({ outcome: 'failed', endedAt: 1002 });
  });

  it('shows queued prompts as queued until their run starts, and records usage', () => {
    const events = log(
      { type: 'user.message', messageId: 'm1', text: 'one' },
      { type: 'run.started', runId: 'r1' },
      { type: 'user.message', messageId: 'm2', text: 'two' },
      { type: 'run.queued', runId: 'r2', messageId: 'm2' },
      { type: 'usage.updated', runId: 'r1', inputTokens: 10, outputTokens: 20, estimated: false },
    );
    const before = buildTimeline(events);
    expect(before.items[1]).toMatchObject({ kind: 'user', queued: true });
    expect(before.runs.find((r) => r.runId === 'r1')).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
    });

    const third: ConversationEvent[] = [
      {
        conversationId: 'c',
        seq: 6,
        at: 2000,
        body: { type: 'user.message', messageId: 'm3', text: 'three' },
      },
      {
        conversationId: 'c',
        seq: 7,
        at: 2001,
        body: { type: 'run.queued', runId: 'r3', messageId: 'm3' },
      },
      { conversationId: 'c', seq: 8, at: 2002, body: { type: 'run.started', runId: 'r2' } },
    ];
    const after = buildTimeline([...events, ...third]);
    expect(after.items[1]).toMatchObject({ text: 'two', queued: false });
    expect(after.items[2]).toMatchObject({ text: 'three', queued: true });
  });
});
