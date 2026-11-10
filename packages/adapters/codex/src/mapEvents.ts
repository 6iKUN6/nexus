import type { AgentEvent } from '@nexus/protocol';

/**
 * Maps `codex app-server` notifications to Nexus run events. One mapper per
 * run: codex interleaves items of several types (agent messages, commands,
 * reasoning), and some content only arrives in `item/completed`, so the
 * mapper tracks which items streamed deltas to avoid double-emitting.
 *
 * Only the fields Nexus reads are typed; unknown notifications and unknown
 * item types are ignored on purpose (codex emits many: hooks, MCP startup,
 * plan deltas, …).
 */

const MAX_TEXT = 2000;

const truncate = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;

type ThreadItem = {
  type: string;
  id: string;
  // commandExecution
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  // fileChange
  changes?: Array<{ path?: string; kind?: unknown }>;
  // mcpToolCall
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  // agentMessage
  text?: string;
  // reasoning
  summary?: string[];
};

type Turn = {
  id: string;
  status: string;
  durationMs?: number | null;
  error?: { message?: string } | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const describeChanges = (changes: ThreadItem['changes']): string => {
  if (!changes || changes.length === 0) return '修改文件';
  const paths = changes.map((c) => c.path ?? '?').slice(0, 5);
  const suffix = changes.length > paths.length ? ` 等 ${changes.length} 个文件` : '';
  return `${paths.join(', ')}${suffix}`;
};

export type RunMapper = {
  handleNotification(method: string, params: unknown): AgentEvent[];
};

export function createRunMapper(runId: string): RunMapper {
  // Items that streamed deltas; their completed payload must not repeat it.
  const streamedText = new Set<string>();
  const streamedReasoning = new Set<string>();

  const mapItemStarted = (item: ThreadItem): AgentEvent[] => {
    switch (item.type) {
      case 'commandExecution':
        return [
          {
            type: 'tool.started',
            runId,
            toolCallId: item.id,
            name: '终端命令',
            input: { command: item.command ?? '', cwd: item.cwd },
          },
        ];
      case 'fileChange':
        return [
          {
            type: 'tool.started',
            runId,
            toolCallId: item.id,
            name: '文件修改',
            input: { changes: describeChanges(item.changes) },
          },
        ];
      case 'mcpToolCall':
        return [
          {
            type: 'tool.started',
            runId,
            toolCallId: item.id,
            name: item.server ? `${item.server}/${item.tool ?? '?'}` : (item.tool ?? 'MCP 工具'),
            input: item.arguments,
          },
        ];
      default:
        return [];
    }
  };

  const mapItemCompleted = (item: ThreadItem): AgentEvent[] => {
    switch (item.type) {
      case 'commandExecution': {
        const ok = item.status === 'completed' && (item.exitCode ?? 0) === 0;
        const output = item.aggregatedOutput?.trim();
        return [
          {
            type: 'tool.completed',
            runId,
            toolCallId: item.id,
            status: ok ? 'ok' : 'error',
            summary: output
              ? truncate(output)
              : item.exitCode != null
                ? `退出码 ${item.exitCode}`
                : '结果未知',
          },
        ];
      }
      case 'fileChange': {
        const ok = item.status === 'completed';
        return [
          {
            type: 'tool.completed',
            runId,
            toolCallId: item.id,
            status: ok ? 'ok' : 'error',
            summary: describeChanges(item.changes),
          },
        ];
      }
      case 'mcpToolCall': {
        const failed = item.error != null || item.status === 'failed';
        const raw = item.error?.message ?? (item.result != null ? JSON.stringify(item.result) : '');
        return [
          {
            type: 'tool.completed',
            runId,
            toolCallId: item.id,
            status: failed ? 'error' : 'ok',
            summary: raw ? truncate(raw) : null,
          },
        ];
      }
      case 'agentMessage':
        // A commentary message often arrives with no deltas at all; the text
        // only exists on the completed item, so emit it here as one delta.
        if (item.text && !streamedText.has(item.id)) {
          return [{ type: 'text.delta', runId, text: item.text }];
        }
        return [];
      case 'reasoning':
        if (!streamedReasoning.has(item.id) && item.summary && item.summary.length > 0) {
          return [{ type: 'thinking.delta', runId, text: item.summary.join('\n') }];
        }
        return [];
      default:
        return [];
    }
  };

  return {
    handleNotification(method, params) {
      const p = asRecord(params);
      switch (method) {
        case 'item/agentMessage/delta': {
          const itemId = typeof p?.itemId === 'string' ? p.itemId : '';
          const delta = typeof p?.delta === 'string' ? p.delta : '';
          if (!delta) return [];
          streamedText.add(itemId);
          return [{ type: 'text.delta', runId, text: delta }];
        }
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta': {
          const itemId = typeof p?.itemId === 'string' ? p.itemId : '';
          const delta = typeof p?.delta === 'string' ? p.delta : '';
          if (!delta) return [];
          streamedReasoning.add(itemId);
          return [{ type: 'thinking.delta', runId, text: delta }];
        }
        case 'item/started': {
          const item = asRecord(p?.item) as ThreadItem | null;
          return item ? mapItemStarted(item) : [];
        }
        case 'item/completed': {
          const item = asRecord(p?.item) as ThreadItem | null;
          return item ? mapItemCompleted(item) : [];
        }
        case 'thread/tokenUsage/updated': {
          const usage = asRecord(p?.tokenUsage);
          const last = asRecord(usage?.last);
          const input = typeof last?.inputTokens === 'number' ? last.inputTokens : null;
          const output = typeof last?.outputTokens === 'number' ? last.outputTokens : null;
          if (input === null && output === null) return [];
          return [
            {
              type: 'usage.updated',
              runId,
              inputTokens: input,
              outputTokens: output,
              estimated: false,
            },
          ];
        }
        case 'turn/completed': {
          const turn = asRecord(p?.turn) as Turn | null;
          if (!turn) {
            return [
              {
                type: 'run.failed',
                runId,
                error: { code: 'no_terminal_event', message: 'Codex 结束了运行但没有返回结果。' },
              },
            ];
          }
          if (turn.status === 'failed') {
            return [
              {
                type: 'run.failed',
                runId,
                error: {
                  code: 'turn_failed',
                  message: turn.error?.message ?? 'Codex 运行失败。',
                },
              },
            ];
          }
          return [
            {
              type: 'run.completed',
              runId,
              stopReason: turn.status === 'interrupted' ? 'cancelled' : 'end_turn',
              durationMs: turn.durationMs ?? null,
            },
          ];
        }
        default:
          return [];
      }
    },
  };
}
