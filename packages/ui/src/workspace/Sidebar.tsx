import { Button, Input, Radio, Tooltip } from '@arco-design/web-react';
import { IconPlus, IconSearch } from '@arco-design/web-react/icon';
import type { Conversation, HarnessCapabilities, HarnessInfo } from '@nexus/protocol';
import { type Ref, useState } from 'react';
import { NexusMark } from '../brand/NexusMark';
import { PERSONAS } from '../model/types';
import type { ThemePreference } from '../theme/themePreference';
import { AgentAvatar } from './AgentAvatar';
import { StatusIcon } from './StatusLabel';
import { ThemeSwitcher } from './ThemeSwitcher';

type SidebarProps = {
  conversations: Conversation[];
  activeId: string | null;
  unread: (conversation: Conversation) => boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  harnesses: HarnessInfo[] | null;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  searchRef: Ref<HTMLInputElement>;
};

const relative = (at: number) => {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

export function Sidebar(props: SidebarProps) {
  const [mode, setMode] = useState<'conversations' | 'agents'>('conversations');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const filtered = props.conversations.filter(
    (c) =>
      !needle || c.title.toLowerCase().includes(needle) || c.cwd.toLowerCase().includes(needle),
  );
  // Inbox: anything that needs the user — permission prompts and failures.
  const inbox = props.conversations.filter(
    (c) => c.state === 'waiting_user' || c.state === 'failed',
  );

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line-2 bg-sidebar">
      {/* Title bar: traffic lights sit on the left (~80px), brand on the right. Draggable. */}
      <div className="flex h-11 shrink-0 items-center justify-end gap-1.5 pr-4 [-webkit-app-region:drag]">
        <NexusMark size={15} className="text-brand-mark" />
        <span className="text-[13px] font-semibold tracking-tight text-brand-mark">Nexus</span>
      </div>

      <div className="flex flex-col gap-2.5 px-3 pb-2">
        <div className="flex gap-2">
          <Input
            ref={props.searchRef as never}
            size="small"
            allowClear
            value={query}
            onChange={setQuery}
            prefix={<IconSearch />}
            suffix={<span className="text-[11px] text-fg-4">⌘K</span>}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
          <Tooltip content="新会话 ⌘T" mini>
            <Button size="small" icon={<IconPlus />} aria-label="新会话" onClick={props.onNew} />
          </Tooltip>
        </div>
        <Radio.Group
          type="button"
          size="mini"
          value={mode}
          onChange={setMode}
          className="flex [&>label]:flex-1 [&>label]:text-center"
        >
          <Radio value="conversations">会话</Radio>
          <Radio value="agents">Agents</Radio>
        </Radio.Group>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="会话">
        {mode === 'conversations' ? (
          <>
            {inbox.length > 0 && (
              <>
                <SectionTitle count={inbox.length}>待我处理</SectionTitle>
                {inbox.map((c) => (
                  <SidebarRow
                    key={`inbox-${c.id}`}
                    selected={false}
                    onClick={() => props.onOpen(c.id)}
                  >
                    <span
                      className={`mt-0.5 size-1.5 shrink-0 self-start rounded-full ${c.state === 'failed' ? 'bg-bad' : 'bg-warn'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-fg-1">
                        {c.state === 'failed' ? '运行失败' : '等待授权'} · {c.title}
                      </span>
                      <span className="block truncate text-xs text-fg-3">{c.preview}</span>
                    </span>
                  </SidebarRow>
                ))}
              </>
            )}

            <SectionTitle>最近会话</SectionTitle>
            {filtered.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                unread={props.unread(conversation)}
                selected={conversation.id === props.activeId}
                onClick={() => props.onOpen(conversation.id)}
              />
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-fg-3">
                {props.conversations.length === 0 ? '还没有会话，点 + 新建' : '没有匹配的会话'}
              </p>
            )}
          </>
        ) : (
          <AgentsView
            conversations={props.conversations}
            harnesses={props.harnesses}
            onOpen={props.onOpen}
          />
        )}
      </nav>

      <footer className="shrink-0 border-t border-line-1 px-3 pt-2 pb-3">
        <SectionTitle className="px-0">Harness</SectionTitle>
        <ul className="m-0 mb-2.5 flex list-none flex-col gap-1 p-0">
          {/* DeepSeek Harness is deferred (2026-11-07); it stays detectable in core but is not shown yet. */}
          {(props.harnesses ?? [])
            .filter((harness) => harness.id !== 'dsh' && harness.id !== 'fake')
            .map((harness) => (
              <HarnessRow key={harness.id} harness={harness} />
            ))}
          {!props.harnesses && <li className="text-xs text-fg-3">检测中…</li>}
        </ul>
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-3">外观</span>
          <ThemeSwitcher value={props.theme} onChange={props.onThemeChange} />
        </div>
      </footer>
    </aside>
  );
}

function SectionTitle({
  children,
  count,
  className = 'px-2',
}: {
  children: React.ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <h3
      className={`m-0 flex items-center gap-1.5 pt-3 pb-1 text-[11px] font-semibold text-fg-3 ${className}`}
    >
      {children}
      {count ? (
        <span className="rounded-full bg-warn px-1.5 text-[10px] leading-4 text-on-accent">
          {count}
        </span>
      ) : null}
    </h3>
  );
}

/** A sidebar navigation row: an Arco text button reshaped into a list item. */
function SidebarRow({
  selected,
  onClick,
  children,
  indent = false,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <Button
      long
      type="text"
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={`flex h-auto items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left font-normal text-fg-1 ${
        indent ? 'ml-5 w-[calc(100%-1.25rem)]' : ''
      } ${selected ? 'bg-tint-3 hover:bg-tint-3' : 'bg-transparent hover:bg-tint-2'}`}
    >
      {children}
    </Button>
  );
}

function ConversationRow({
  conversation,
  selected,
  unread,
  onClick,
}: {
  conversation: Conversation;
  selected: boolean;
  unread: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarRow selected={selected} onClick={onClick}>
      <span className="relative">
        <AgentAvatar agent={conversation.harnessId} />
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full bg-elevated text-[10px]">
          <StatusIcon state={conversation.state} />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1">
          <span
            className={`truncate text-[13px] text-fg-1 ${unread ? 'font-semibold' : 'font-medium'}`}
          >
            {conversation.title}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-fg-3">
            {relative(conversation.updatedAt)}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span className="truncate text-xs text-fg-3">{conversation.preview}</span>
          {unread && (
            <span className="ml-auto size-2 shrink-0 rounded-full bg-brand">
              <span className="sr-only">有未读</span>
            </span>
          )}
        </span>
      </span>
    </SidebarRow>
  );
}

const CAPABILITY_LABELS: Array<[keyof HarnessCapabilities, string]> = [
  ['streaming', '流式'],
  ['permissions', '权限卡片'],
  ['cancel', '取消'],
  ['interrupt', '中断注入'],
  ['resume', '会话续传'],
  ['fork', '分支'],
  ['mcp', 'MCP'],
  ['usage', '用量统计'],
];

const AUTH_LABEL: Record<HarnessInfo['auth'], string> = {
  unknown: '认证状态未知',
  authenticated: '已认证',
  unauthenticated: '未认证',
};

/** Read-only harness management (D13): detection, auth, capabilities, limitations. */
function AgentsView({
  conversations,
  harnesses,
  onOpen,
}: {
  conversations: Conversation[];
  harnesses: HarnessInfo[] | null;
  onOpen: (id: string) => void;
}) {
  const visible = (harnesses ?? []).filter((h) => h.id !== 'dsh');
  if (!harnesses) return <p className="px-2 py-4 text-center text-xs text-fg-3">检测中…</p>;
  return (
    <>
      {visible.map((h) => {
        const owned = conversations.filter((c) => c.harnessId === h.id);
        return (
          <section key={h.id} className="mb-1 px-2 pt-3">
            <div className="flex items-center gap-2 pb-1">
              <AgentAvatar agent={h.id} size="sm" />
              <span className="text-[13px] font-semibold text-fg-1">{PERSONAS[h.id].name}</span>
              <span className="ml-auto text-[11px] text-fg-3">
                {h.chatSupported ? `${owned.length} 个会话` : 'M2'}
              </span>
            </div>
            <div className="rounded-lg border border-line-1 bg-elevated px-2.5 py-2">
              <dl className="m-0 grid grid-cols-[52px_1fr] gap-x-2 gap-y-1 text-[11px]">
                <dt className="text-fg-3">状态</dt>
                <dd className="m-0 text-fg-1">
                  {!h.installed ? '未安装' : `${h.version ?? '已安装'} · ${AUTH_LABEL[h.auth]}`}
                </dd>
                {h.executablePath && (
                  <>
                    <dt className="text-fg-3">路径</dt>
                    <dd
                      className="nx-selectable m-0 truncate font-mono text-fg-2"
                      title={h.executablePath}
                    >
                      {h.executablePath}
                    </dd>
                  </>
                )}
                {h.capabilities && (
                  <>
                    <dt className="text-fg-3">能力</dt>
                    <dd className="m-0 flex flex-wrap gap-1">
                      {CAPABILITY_LABELS.map(([key, label]) => (
                        <span
                          key={key}
                          className={`rounded px-1 py-px ${
                            h.capabilities?.[key]
                              ? 'bg-tint-2 text-fg-1'
                              : 'bg-tint-1 text-fg-4 line-through'
                          }`}
                        >
                          {label}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
              {h.problem && <p className="m-0 mt-1.5 text-[11px] text-warn">{h.problem}</p>}
              {(h.limitations ?? []).map((limitation) => (
                <p key={limitation} className="m-0 mt-1 text-[11px] leading-relaxed text-fg-3">
                  · {limitation}
                </p>
              ))}
            </div>
            {owned.map((c) => (
              <SidebarRow key={c.id} selected={false} onClick={() => onOpen(c.id)}>
                <StatusIcon state={c.state} />
                <span className="truncate text-xs text-fg-2">{c.title}</span>
              </SidebarRow>
            ))}
          </section>
        );
      })}
    </>
  );
}

function HarnessRow({ harness }: { harness: HarnessInfo }) {
  const status = !harness.installed
    ? { text: '未安装', dot: 'bg-sys-gray' }
    : harness.problem
      ? { text: '异常', dot: 'bg-warn' }
      : { text: harness.version ?? '已安装', dot: 'bg-ok' };
  return (
    <li className="flex items-center gap-2 text-xs">
      <AgentAvatar agent={harness.id} size="xs" />
      <Tooltip
        content={harness.problem ?? harness.executablePath ?? '未在 PATH 中找到'}
        mini
        position="right"
      >
        <span className="truncate text-fg-2">{harness.displayName}</span>
      </Tooltip>
      <span className="ml-auto flex items-center gap-1 text-fg-3">
        <span className={`size-1.5 rounded-full ${status.dot}`} />
        {status.text}
        {harness.installed && !harness.chatSupported && <span className="text-fg-4">· M2</span>}
      </span>
    </li>
  );
}
