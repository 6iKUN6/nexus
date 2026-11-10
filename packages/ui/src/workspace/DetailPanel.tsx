import { Button, Message, Tooltip } from '@arco-design/web-react';
import { IconCopy } from '@arco-design/web-react/icon';
import type { Conversation, HarnessInfo } from '@nexus/protocol';
import { PERSONAS, type RunSummary } from '../model/types';
import { AgentAvatar } from './AgentAvatar';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line-1 px-4 py-3 last:border-none">
      <h3 className="m-0 mb-2 text-[11px] font-semibold text-fg-3">{title}</h3>
      {children}
    </section>
  );
}

const OUTCOME: Record<RunSummary['outcome'], { text: string; className: string }> = {
  queued: { text: '排队中', className: 'text-fg-3' },
  running: { text: '运行中', className: 'text-brand' },
  completed: { text: '执行结束', className: 'text-ok' },
  cancelled: { text: '已停止', className: 'text-fg-3' },
  failed: { text: '失败', className: 'text-bad' },
};

const clock = (at: number | null) =>
  at === null
    ? '—'
    : new Date(at).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

export function DetailPanel({
  conversation,
  harness,
  runs,
}: {
  conversation: Conversation;
  harness: HarnessInfo | undefined;
  runs: RunSummary[];
}) {
  const tokens = runs.reduce(
    (sum, r) => ({
      input: sum.input + (r.inputTokens ?? 0),
      output: sum.output + (r.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => Message.success('已复制'));
  };

  return (
    <aside
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line-2 bg-surface-1"
      aria-label="会话详情"
    >
      <Section title="执行者">
        <div className="flex items-center gap-2 text-xs text-fg-1">
          <AgentAvatar agent={conversation.harnessId} size="sm" />
          {PERSONAS[conversation.harnessId].name}
          <span className="ml-auto font-mono text-[11px] text-fg-3">{harness?.version ?? ''}</span>
        </div>
        {harness?.executablePath && (
          <div
            className="nx-selectable mt-1.5 truncate font-mono text-[11px] text-fg-3"
            title={harness.executablePath}
          >
            {harness.executablePath}
          </div>
        )}
      </Section>

      <Section title="工作目录">
        <div className="flex items-start gap-1">
          <span className="nx-selectable min-w-0 flex-1 font-mono text-[11px] break-all text-fg-1">
            {conversation.cwd}
          </span>
          <Tooltip content="复制路径" mini>
            <Button
              size="mini"
              type="text"
              icon={<IconCopy />}
              aria-label="复制路径"
              onClick={() => copy(conversation.cwd)}
            />
          </Tooltip>
        </div>
        <p className="m-0 mt-2 text-[11px] text-warn">
          直接在此目录运行。独立 worktree 隔离将在 M2 提供。
        </p>
      </Section>

      <Section title="会话">
        <dl className="m-0 grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-fg-3">创建</dt>
          <dd className="m-0 text-fg-1">{clock(conversation.createdAt)}</dd>
          <dt className="text-fg-3">会话 ID</dt>
          <dd
            className="nx-selectable m-0 truncate font-mono text-[11px] text-fg-1"
            title={conversation.externalSessionId ?? ''}
          >
            {conversation.externalSessionId ?? '首次运行后生成'}
          </dd>
          <dt className="text-fg-3">Tokens</dt>
          <dd className="m-0 text-fg-1">
            {tokens.input + tokens.output > 0
              ? `输入 ${tokens.input.toLocaleString()} · 输出 ${tokens.output.toLocaleString()}`
              : '—'}
          </dd>
        </dl>
      </Section>

      <Section title={`运行记录${runs.length ? ` · ${runs.length}` : ''}`}>
        {runs.length === 0 ? (
          <p className="m-0 text-xs text-fg-3">还没有运行</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {[...runs].reverse().map((run) => (
              <li key={run.runId} className="flex gap-2 text-xs">
                <span className="w-[86px] shrink-0 text-fg-3">{clock(run.startedAt)}</span>
                <span className={OUTCOME[run.outcome].className}>{OUTCOME[run.outcome].text}</span>
                {run.endedAt && run.startedAt && (
                  <span className="ml-auto text-fg-3">
                    {Math.max(
                      1,
                      Math.round((run.durationMs ?? run.endedAt - run.startedAt) / 1000),
                    )}
                    s
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="m-0 mt-2 text-[11px] text-fg-3">
          执行结束 ≠ 验收通过；任务与验收标准将在 M3 引入。
        </p>
      </Section>
    </aside>
  );
}
