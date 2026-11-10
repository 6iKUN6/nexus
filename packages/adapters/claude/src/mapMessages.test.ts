import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentEvent, agentEventSchema } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { createMapperState, mapSdkMessage, summarizeToolInput } from './mapMessages';

/** Fixtures are sanitized recordings of real claude 2.1.319 stream-json output (M0 probes). */
function replay(name: string): AgentEvent[] {
  const lines = readFileSync(join(import.meta.dirname, '../fixtures', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);
  const state = createMapperState('r1');
  return lines.flatMap((line) => mapSdkMessage(JSON.parse(line), state));
}

describe('mapSdkMessage (recorded fixtures)', () => {
  it('maps a file-read turn to tool start/complete, text and one terminal event', () => {
    const events = replay('tool');
    for (const event of events) expect(agentEventSchema.parse(event)).toEqual(event);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'tool.started')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool.completed')).toHaveLength(1);
    expect(types.at(-1)).toBe('run.completed');
    expect(types.filter((t) => t === 'run.completed' || t === 'run.failed')).toHaveLength(1);

    const started = events.find((e) => e.type === 'tool.started');
    expect(started).toMatchObject({ name: 'Read', input: { file_path: expect.any(String) } });
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ status: 'ok' });
    if (completed?.type === 'tool.completed')
      expect(completed.summary).toContain('NEXUS-PROBE-LINE-1');

    const text = events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
    expect(text).toContain('NEXUS-PROBE-LINE-1');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'usage.updated', estimated: false }),
    );
  });

  it('reports an auto-denied write as a failed tool call, not a failed run', () => {
    const events = replay('permission');
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ status: 'error' });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' });
  });

  it('streams long Chinese output as many deltas that join losslessly', () => {
    const events = replay('chinese');
    const deltas = events.filter((e) => e.type === 'text.delta');
    expect(deltas.length).toBeGreaterThan(20);
    const text = deltas.map((e) => (e.type === 'text.delta' ? e.text : '')).join('');
    expect(text).toContain('完毕');
    expect(text).not.toContain('�');
  });
});

describe('mapSdkMessage (edge cases)', () => {
  it('turns an error result into run.failed with the assistant error code', () => {
    const state = createMapperState('r1');
    mapSdkMessage(
      { type: 'assistant', error: 'authentication_failed', message: { content: [] } },
      state,
    );
    const events = mapSdkMessage(
      { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key', usage: {} },
      state,
    );
    expect(events.at(-1)).toEqual({
      type: 'run.failed',
      runId: 'r1',
      error: { code: 'authentication_failed', message: 'Invalid API key' },
    });
  });

  it('ignores sub-agent messages and anything after the terminal event', () => {
    const state = createMapperState('r1');
    const delta = (text: string, parent: string | null) => ({
      type: 'stream_event',
      parent_tool_use_id: parent,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    expect(mapSdkMessage(delta('sub', 'toolu_1'), state)).toEqual([]);
    expect(mapSdkMessage(delta('main', null), state)).toHaveLength(1);
    mapSdkMessage({ type: 'result', subtype: 'success', usage: {} }, state);
    expect(mapSdkMessage(delta('late', null), state)).toEqual([]);
  });

  it('maps thinking deltas, tagging sub-agent thinking with its parent call', () => {
    const state = createMapperState('r1');
    const delta = (text: string, parent: string | null) => ({
      type: 'stream_event',
      parent_tool_use_id: parent,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: text } },
    });
    expect(mapSdkMessage(delta('想想', null), state)).toEqual([
      { type: 'thinking.delta', runId: 'r1', text: '想想', parentToolCallId: null },
    ]);
    expect(mapSdkMessage(delta('子代理想', 'toolu_9'), state)).toEqual([
      { type: 'thinking.delta', runId: 'r1', text: '子代理想', parentToolCallId: 'toolu_9' },
    ]);
  });

  it('nests sub-agent tool calls under their parent and still pairs their results', () => {
    const state = createMapperState('r1');
    const started = mapSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_child', name: 'Grep', input: { pattern: 'x' } }],
        },
      },
      state,
    );
    expect(started).toEqual([
      {
        type: 'tool.started',
        runId: 'r1',
        toolCallId: 'toolu_child',
        name: 'Grep',
        input: { pattern: 'x' },
        parentToolCallId: 'toolu_parent',
      },
    ]);
    const completed = mapSdkMessage(
      {
        type: 'user',
        parent_tool_use_id: 'toolu_parent',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: '3 matches' }],
        },
      },
      state,
    );
    expect(completed).toEqual([
      {
        type: 'tool.completed',
        runId: 'r1',
        toolCallId: 'toolu_child',
        status: 'ok',
        summary: '3 matches',
      },
    ]);
  });

  it('carries the reported duration on run.completed', () => {
    const state = createMapperState('r1');
    const events = mapSdkMessage(
      { type: 'result', subtype: 'success', duration_ms: 12345, usage: {} },
      state,
    );
    expect(events).toContainEqual({
      type: 'run.completed',
      runId: 'r1',
      stopReason: 'other',
      durationMs: 12345,
    });
  });

  it('summarizes tool input to the fields a human needs', () => {
    expect(summarizeToolInput({ file_path: '/a.ts', content: 'x'.repeat(5000) })).toEqual({
      file_path: '/a.ts',
    });
    const big = summarizeToolInput({ blob: 'y'.repeat(5000) }) as { preview: string };
    expect(big.preview.length).toBeLessThan(2100);
  });
});
