import type { ConversationEvent } from '@nexus/protocol';
import type { RunSummary, TimelineItem } from './types';

/**
 * Folds a conversation's event log into timeline items and run summaries.
 * Pure and deterministic: the same events always give the same timeline, so
 * reloads, reconnects and restarts render identically.
 *
 * - Consecutive text deltas of a run form one agent bubble; a tool call or
 *   permission prompt closes the bubble, later text starts a new one.
 * - A tool without a completion when its run ended is `unknown`, never `ok`.
 * - A permission prompt whose run ended unanswered is `expired`.
 */
export function buildTimeline(events: readonly ConversationEvent[]): {
  items: TimelineItem[];
  runs: RunSummary[];
} {
  const items: TimelineItem[] = [];
  const runs = new Map<string, RunSummary>();
  const openText = new Map<string, Extract<TimelineItem, { kind: 'agent' }>>();
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
  const permissions = new Map<string, Extract<TimelineItem, { kind: 'permission' }>>();
  const userByMessage = new Map<string, Extract<TimelineItem, { kind: 'user' }>>();
  const queuedUserByRun = new Map<string, Extract<TimelineItem, { kind: 'user' }>>();

  const run = (runId: string): RunSummary => {
    let summary = runs.get(runId);
    if (!summary) {
      summary = {
        runId,
        startedAt: null,
        endedAt: null,
        outcome: 'queued',
        inputTokens: null,
        outputTokens: null,
      };
      runs.set(runId, summary);
    }
    return summary;
  };

  const endRun = (runId: string, at: number, outcome: RunSummary['outcome']) => {
    const summary = run(runId);
    summary.endedAt = at;
    summary.outcome = outcome;
    const text = openText.get(runId);
    if (text) text.streaming = false;
    openText.delete(runId);
    for (const tool of tools.values()) {
      if (tool.runId === runId && tool.status === 'running') tool.status = 'unknown';
    }
    for (const permission of permissions.values()) {
      if (permission.runId === runId && permission.state === 'pending')
        permission.state = 'expired';
    }
  };

  for (const { seq, at, body } of events) {
    const id = `e${seq}`;
    switch (body.type) {
      case 'user.message': {
        const item = { kind: 'user' as const, id, at, text: body.text, queued: false };
        userByMessage.set(body.messageId, item);
        items.push(item);
        break;
      }
      case 'run.queued': {
        run(body.runId);
        const user = userByMessage.get(body.messageId);
        if (user) {
          user.queued = true;
          queuedUserByRun.set(body.runId, user);
        }
        break;
      }
      case 'run.started': {
        const summary = run(body.runId);
        summary.startedAt = at;
        summary.outcome = 'running';
        const queuedUser = queuedUserByRun.get(body.runId);
        if (queuedUser) queuedUser.queued = false;
        break;
      }
      case 'text.delta': {
        const current = openText.get(body.runId);
        if (current) {
          current.text += body.text;
        } else {
          const item = {
            kind: 'agent' as const,
            id,
            at,
            runId: body.runId,
            text: body.text,
            streaming: true,
          };
          openText.set(body.runId, item);
          items.push(item);
        }
        break;
      }
      case 'tool.started': {
        const text = openText.get(body.runId);
        if (text) text.streaming = false;
        openText.delete(body.runId);
        const item = {
          kind: 'tool' as const,
          id,
          runId: body.runId,
          name: body.name,
          detail: describeInput(body.input),
          status: 'running' as const,
          output: null,
        };
        tools.set(body.toolCallId, item);
        items.push(item);
        break;
      }
      case 'tool.completed': {
        const tool = tools.get(body.toolCallId);
        if (tool) {
          tool.status = body.status;
          tool.output = body.summary;
        }
        break;
      }
      case 'permission.requested': {
        const text = openText.get(body.runId);
        if (text) text.streaming = false;
        openText.delete(body.runId);
        const item = {
          kind: 'permission' as const,
          id,
          runId: body.runId,
          requestId: body.requestId,
          description: body.description,
          options: body.options,
          state: 'pending' as const,
          chosen: null,
        };
        permissions.set(body.requestId, item);
        items.push(item);
        break;
      }
      case 'permission.resolved': {
        const permission = permissions.get(body.requestId);
        if (permission) {
          permission.state = 'resolved';
          permission.chosen = permission.options.find((o) => o.id === body.optionId) ?? null;
        }
        break;
      }
      case 'input.requested':
        items.push({
          kind: 'system',
          id,
          text: `Agent 请求输入：${body.prompt}（暂不支持在界面中回复）`,
        });
        break;
      case 'usage.updated': {
        const summary = run(body.runId);
        summary.inputTokens = body.inputTokens;
        summary.outputTokens = body.outputTokens;
        break;
      }
      case 'run.completed':
        endRun(body.runId, at, body.stopReason === 'cancelled' ? 'cancelled' : 'completed');
        if (body.stopReason === 'cancelled')
          items.push({ kind: 'system', id, text: '你停止了这次运行' });
        if (body.stopReason === 'refused')
          items.push({ kind: 'system', id, text: '这次运行因权限被拒绝而结束' });
        if (body.stopReason === 'max_tokens')
          items.push({ kind: 'system', id, text: '输出达到长度上限，回复可能不完整' });
        break;
      case 'run.failed':
        endRun(body.runId, at, 'failed');
        items.push({
          kind: 'failure',
          id,
          runId: body.runId,
          code: body.error.code,
          message: body.error.message,
        });
        break;
    }
  }

  return { items, runs: [...runs.values()] };
}

function describeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return String(input);
  const values = Object.values(input as Record<string, unknown>).filter(
    (v): v is string => typeof v === 'string',
  );
  return values.length > 0 ? values.join(' · ') : JSON.stringify(input);
}

const FAILURE_TITLES: Record<string, string> = {
  interrupted: '运行被中断',
  not_installed: '未找到 Claude Code',
  authentication_failed: '登录已失效',
  billing_error: '账户额度或计费问题',
  rate_limit: '触发了速率限制',
  overloaded: '服务暂时过载',
  no_terminal_event: '运行结果未知',
};

export function failureTitle(code: string): string {
  return FAILURE_TITLES[code] ?? '运行失败';
}
