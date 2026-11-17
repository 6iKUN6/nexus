import { Button, Checkbox, Input, Message, Modal, Select, Tooltip } from '@arco-design/web-react';
import { IconCopy, IconEdit } from '@arco-design/web-react/icon';
import type { Conversation, HarnessId, HarnessInfo, McpServerView } from '@nexus/protocol';
import { useState } from 'react';
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

/** Above this many runs a task has outgrown "just a chat"; nudging the goal
 *  is then worth it (D22). Pure heuristic — no model call decides this. */
const GOAL_NUDGE_RUNS = 5;

function TaskSection({
  conversation,
  harness,
  harnesses,
  runs,
  mcpServers,
  onConfigure,
}: {
  conversation: Conversation;
  harness: HarnessInfo | undefined;
  harnesses: HarnessInfo[] | null;
  runs: RunSummary[];
  mcpServers: McpServerView[];
  onConfigure: (patch: {
    goal?: string | null;
    fallbackHarnessId?: HarnessId | null;
    enabledMcpIds?: string[];
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const candidates = (harnesses ?? []).filter(
    (h) => h.chatSupported && h.id !== conversation.harnessId,
  );
  const nudge = !conversation.goal && runs.length >= GOAL_NUDGE_RUNS;

  return (
    <Section title="任务">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 text-xs leading-relaxed text-fg-1">
          {conversation.goal ?? <span className="text-fg-3">未设置目标</span>}
        </span>
        <Tooltip content="编辑目标" mini>
          <Button
            size="mini"
            type="text"
            icon={<IconEdit />}
            aria-label="编辑目标"
            onClick={() => {
              setDraft(conversation.goal ?? '');
              setEditing(true);
            }}
          />
        </Tooltip>
      </div>
      {nudge && (
        <p className="m-0 mt-1.5 text-[11px] text-fg-3">
          任务已跑 {runs.length} 轮；定个目标能让交接时的上下文更准确。
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-fg-3">备用执行者</span>
        <Select
          size="mini"
          className="min-w-0 flex-1"
          value={conversation.fallbackHarnessId ?? undefined}
          placeholder="未设置"
          allowClear
          aria-label="备用执行者"
          onChange={(value) =>
            onConfigure({
              fallbackHarnessId: typeof value === 'string' && value ? (value as HarnessId) : null,
            })
          }
        >
          {candidates.map((h) => (
            <Select.Option key={h.id} value={h.id}>
              {PERSONAS[h.id]?.name ?? h.displayName}
            </Select.Option>
          ))}
        </Select>
      </div>
      <p className="m-0 mt-1.5 text-[11px] text-fg-3">运行失败时，交接对话框会预填这个执行者。</p>
      <McpOptIn
        conversation={conversation}
        harness={harness}
        servers={mcpServers}
        onConfigure={onConfigure}
      />
      <Modal
        visible={editing}
        title="任务目标"
        okText="保存"
        cancelText="取消"
        onOk={() => {
          onConfigure({ goal: draft.trim() ? draft.trim() : null });
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      >
        <Input.TextArea
          value={draft}
          onChange={setDraft}
          maxLength={500}
          autoSize={{ minRows: 2, maxRows: 6 }}
          aria-label="任务目标"
          placeholder="这个任务最终要达成什么；交接时会作为目标预填"
        />
      </Modal>
    </Section>
  );
}

export function DetailPanel({
  conversation,
  harness,
  runs,
  harnesses,
  mcpServers,
  onConfigure,
}: {
  conversation: Conversation;
  harness: HarnessInfo | undefined;
  runs: RunSummary[];
  harnesses: HarnessInfo[] | null;
  /** Global MCP server list for the per-conversation opt-in (D23). */
  mcpServers: McpServerView[];
  onConfigure: (patch: {
    goal?: string | null;
    fallbackHarnessId?: HarnessId | null;
    enabledMcpIds?: string[];
  }) => void;
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
    <aside className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto" aria-label="会话详情">
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
        {conversation.isolation === 'worktree' ? (
          <p className="m-0 mt-2 text-[11px] leading-relaxed text-ok">
            在独立 worktree 中运行，不影响你的工作区。
            {conversation.baseCwd && (
              <span className="block text-fg-3">基于 {conversation.baseCwd}</span>
            )}
          </p>
        ) : (
          <p className="m-0 mt-2 text-[11px] text-warn">直接在此目录运行，改动立即生效。</p>
        )}
      </Section>

      <TaskSection
        conversation={conversation}
        harness={harness}
        harnesses={harnesses}
        runs={runs}
        mcpServers={mcpServers}
        onConfigure={onConfigure}
      />

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
          执行结束 ≠ 验收通过：委派的子任务由你在委派会话中验收（M3）。
        </p>
      </Section>
    </aside>
  );
}

/** Per-conversation MCP opt-in (D23). Only Claude Code has verified injection;
 * other harnesses get an honest disabled line instead of a fake checkbox. */
function McpOptIn({
  conversation,
  harness,
  servers,
  onConfigure,
}: {
  conversation: Conversation;
  harness: HarnessInfo | undefined;
  servers: McpServerView[];
  onConfigure: (patch: { enabledMcpIds?: string[] }) => void;
}) {
  if (servers.length === 0) return null;
  // Injection is verified for Claude (SDK mcpServers) and Codex
  // (thread config.mcp_servers, ADR 0020); pi has extensions instead.
  const injectable =
    (conversation.harnessId === 'claude-code' || conversation.harnessId === 'codex') &&
    harness?.capabilities?.mcp === true;
  const available = servers.filter((server) => server.enabled);
  return (
    <div className="mt-2 border-t border-line-1 pt-2">
      <span className="text-[11px] text-fg-3">MCP 工具</span>
      {!injectable ? (
        <p className="m-0 mt-1 text-[11px] leading-relaxed text-fg-3">
          {conversation.harnessId === 'pi'
            ? 'pi 不支持 MCP；它的拓展在 Agents 视图管理。'
            : '当前执行者不支持 MCP 注入。'}
        </p>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          {available.map((server) => (
            <Checkbox
              key={server.id}
              checked={conversation.enabledMcpIds.includes(server.id)}
              onChange={(checked) =>
                onConfigure({
                  enabledMcpIds: checked
                    ? [...conversation.enabledMcpIds, server.id]
                    : conversation.enabledMcpIds.filter((id) => id !== server.id),
                })
              }
            >
              <span className="text-xs text-fg-1">{server.name}</span>
              {server.unresolvedEnv.length > 0 && (
                <span className="ml-1 text-[11px] text-warn">缺环境变量</span>
              )}
            </Checkbox>
          ))}
          <p className="m-0 text-[11px] leading-relaxed text-fg-3">
            勾选后下次运行生效；已运行的会话不热加载。
          </p>
        </div>
      )}
    </div>
  );
}
