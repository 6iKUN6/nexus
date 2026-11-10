import type { AgentEvent, StopReason } from '@nexus/protocol';

/**
 * Pure translation from Claude Agent SDK messages to Nexus AgentEvents.
 * Shapes were verified against recorded `stream-json` output of
 * claude 2.1.319 (fixtures/*.jsonl), which is the same message format the SDK
 * yields. Text comes only from stream deltas (assistant messages carry empty
 * text when partial messages are on); tool calls come from assistant
 * `tool_use` blocks and their results from user `tool_result` blocks.
 *
 * Input is typed loosely on purpose: the SDK union is large, and anything we
 * don't recognise is ignored rather than failing the run.
 */

type Json = Record<string, unknown>;

export type MapperState = {
  runId: string;
  /** tool_use id → tool name, for pairing results. */
  tools: Map<string, string>;
  /** Set by an assistant message `error` field; used if the run then fails. */
  assistantError: string | null;
  terminal: boolean;
};

export function createMapperState(runId: string): MapperState {
  return { runId, tools: new Map(), assistantError: null, terminal: false };
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_SUMMARY = 240;
const MAX_INPUT = 600;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Keeps the fields a human needs to recognise the call; large payloads are cut. */
export function summarizeToolInput(input: unknown): unknown {
  if (!isObject(input)) return input ?? null;
  const picked: Json = {};
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'query']) {
    if (typeof input[key] === 'string') picked[key] = truncate(input[key], MAX_INPUT);
  }
  if (Object.keys(picked).length > 0) return picked;
  const json = JSON.stringify(input);
  return json.length > MAX_INPUT ? { preview: truncate(json, MAX_INPUT) } : input;
}

function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || null;
  }
  return null;
}

function mapStopReason(reason: unknown): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refused';
    default:
      return 'other';
  }
}

export function mapSdkMessage(message: unknown, state: MapperState): AgentEvent[] {
  if (!isObject(message) || state.terminal) return [];
  const { runId } = state;
  // Sub-agent traffic (parent_tool_use_id set) is not shown in the main timeline yet.
  if (typeof message.parent_tool_use_id === 'string') return [];

  switch (message.type) {
    case 'stream_event': {
      const event = message.event;
      if (!isObject(event) || event.type !== 'content_block_delta') return [];
      const delta = event.delta;
      if (isObject(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
        return delta.text ? [{ type: 'text.delta', runId, text: delta.text }] : [];
      }
      return [];
    }

    case 'assistant': {
      if (typeof message.error === 'string') state.assistantError = message.error;
      const content = isObject(message.message) ? message.message.content : null;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_use') continue;
        const toolCallId = String(block.id ?? '');
        const name = String(block.name ?? 'tool');
        if (!toolCallId || state.tools.has(toolCallId)) continue;
        state.tools.set(toolCallId, name);
        events.push({
          type: 'tool.started',
          runId,
          toolCallId,
          name,
          input: summarizeToolInput(block.input),
        });
      }
      return events;
    }

    case 'user': {
      const content = isObject(message.message) ? message.message.content : null;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue;
        const toolCallId = String(block.tool_use_id ?? '');
        if (!state.tools.has(toolCallId)) continue;
        const text = toolResultText(block.content);
        events.push({
          type: 'tool.completed',
          runId,
          toolCallId,
          status: block.is_error === true ? 'error' : 'ok',
          summary: text === null ? null : truncate(text.trim(), MAX_SUMMARY),
        });
      }
      return events;
    }

    case 'result': {
      state.terminal = true;
      const events: AgentEvent[] = [];
      const usage = message.usage;
      if (isObject(usage)) {
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
        const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
        events.push({
          type: 'usage.updated',
          runId,
          inputTokens: input,
          outputTokens: output,
          estimated: false,
        });
      }
      if (message.subtype === 'success' && message.is_error !== true) {
        events.push({
          type: 'run.completed',
          runId,
          stopReason: mapStopReason(message.stop_reason),
        });
        return events;
      }
      const errors = Array.isArray(message.errors) ? message.errors.map(String) : [];
      const resultText = typeof message.result === 'string' ? message.result : '';
      events.push({
        type: 'run.failed',
        runId,
        error: {
          code: state.assistantError ?? String(message.subtype ?? 'error'),
          message: truncate(errors.join('\n') || resultText || 'Claude Code 运行失败', 1000),
        },
      });
      return events;
    }

    default:
      return [];
  }
}
