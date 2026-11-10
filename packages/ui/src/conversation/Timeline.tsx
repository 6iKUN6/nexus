import { Button, Spin } from '@arco-design/web-react';
import { IconArrowDown } from '@arco-design/web-react/icon';
import type { HarnessId, PermissionOption } from '@nexus/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PERSONAS, type TimelineItem } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';
import { DelegationCard } from './DelegationCard';
import { HandoffCard } from './HandoffCard';
import { MessageText } from './MessageText';
import { FailureCard, PermissionCard, ThinkingCard, ToolCard } from './TimelineCards';

type TimelineProps = {
  conversationId: string;
  agent: HarnessId;
  items: TimelineItem[] | null;
  /** Changes on every new event, including streamed text inside an existing bubble. */
  revision: number;
  onPermission: (requestId: string, option: PermissionOption) => void;
  onRetry: (() => void) | null;
  onOpenConversation: (id: string) => void;
  onTaskRespond: (taskId: string, action: 'accept' | 'request_changes', feedback?: string) => void;
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Keeps the reader's position: follows new output only when already at the
 * bottom; otherwise shows a "new messages" pill instead of jumping.
 */
export function Timeline({
  conversationId,
  agent,
  items,
  revision,
  onPermission,
  onRetry,
  onOpenConversation,
  onTaskRespond,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const seenRevisionRef = useRef(revision);
  const [hasNew, setHasNew] = useState(false);
  const loaded = items !== null;

  // New conversation (or its history just arrived): jump to the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation or load state changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    seenRevisionRef.current = revision;
    setHasNew(false);
  }, [conversationId, loaded]);

  useEffect(() => {
    if (revision === seenRevisionRef.current) return;
    seenRevisionRef.current = revision;
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    else setHasNew(true);
  }, [revision]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottomRef.current) setHasNew(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto"
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-[780px] flex-col gap-3 px-6 py-5">
          {!items ? (
            <div className="flex justify-center py-10">
              <Spin />
            </div>
          ) : items.length === 0 ? (
            <EmptyConversation agent={agent} />
          ) : (
            items.map((item, index) => (
              <TimelineRow
                key={item.id}
                item={item}
                previous={items[index - 1]}
                agent={agent}
                onPermission={onPermission}
                onRetry={item.kind === 'failure' && index === items.length - 1 ? onRetry : null}
                onOpenConversation={onOpenConversation}
                onTaskRespond={onTaskRespond}
              />
            ))
          )}
        </div>
      </div>
      {hasNew && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="small"
            shape="round"
            type="primary"
            icon={<IconArrowDown />}
            className="pointer-events-auto shadow-mac"
            onClick={() => {
              const el = scrollRef.current;
              el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }}
          >
            有新消息
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyConversation({ agent }: { agent: HarnessId }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <AgentAvatar agent={agent} />
      <div className="text-[13px] font-medium text-fg-1">和 {PERSONAS[agent].name} 开始对话</div>
      <div className="max-w-[360px] text-xs text-fg-3">
        Agent 会在这个会话的工作目录中运行。写文件、执行命令等操作会先在这里请求你的许可。
      </div>
    </div>
  );
}

function TimelineRow({
  item,
  previous,
  agent,
  onPermission,
  onRetry,
  onOpenConversation,
  onTaskRespond,
}: {
  item: TimelineItem;
  previous: TimelineItem | undefined;
  agent: HarnessId;
  onPermission: TimelineProps['onPermission'];
  onRetry: TimelineProps['onRetry'];
  onOpenConversation: TimelineProps['onOpenConversation'];
  onTaskRespond: TimelineProps['onTaskRespond'];
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1">
          <span className="pr-1 text-[11px] text-fg-3">
            {item.queued ? '排队中 · ' : ''}
            {time(item.at)}
          </span>
          <div
            className={`nx-selectable max-w-[78%] rounded-[18px] rounded-br-md bg-bubble-out px-3.5 py-2 text-[13px] leading-relaxed text-on-accent ${item.queued ? 'opacity-60' : ''}`}
          >
            <MessageText text={item.text} />
          </div>
        </div>
      );
    case 'agent': {
      // Consecutive output of one run is grouped under one name line (IM style).
      const grouped =
        previous !== undefined &&
        previous.kind !== 'user' &&
        'runId' in previous &&
        previous.runId === item.runId;
      return (
        <div className="flex gap-2.5">
          <div className="w-8 shrink-0">{!grouped && <AgentAvatar agent={agent} />}</div>
          <div className="flex min-w-0 max-w-[85%] flex-col gap-1">
            {!grouped && (
              <span className="text-[11px] text-fg-3">
                <span className="font-medium text-fg-2">{PERSONAS[agent].name}</span> ·{' '}
                {time(item.at)}
              </span>
            )}
            <div className="nx-selectable rounded-[18px] rounded-tl-md bg-bubble-in px-3.5 py-2 text-[13px] leading-relaxed text-fg-1">
              <MessageText text={item.text} />
              {item.streaming && (
                <span className="nx-pulse ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-fg-3" />
              )}
            </div>
          </div>
        </div>
      );
    }
    case 'system':
      return <div className="py-1 text-center text-[11px] text-fg-3">{item.text}</div>;
    default:
      return (
        <div className="ml-[42px]">
          {item.kind === 'thinking' && <ThinkingCard item={item} />}
          {item.kind === 'tool' && <ToolCard item={item} />}
          {item.kind === 'permission' && (
            <PermissionCard
              item={item}
              agent={agent}
              onRespond={(o) => onPermission(item.requestId, o)}
            />
          )}
          {item.kind === 'failure' && <FailureCard item={item} onRetry={onRetry} />}
          {item.kind === 'delegation' && (
            <DelegationCard
              item={item}
              onOpenConversation={onOpenConversation}
              onRespond={onTaskRespond}
            />
          )}
          {item.kind === 'handoff' && <HandoffCard item={item} />}
        </div>
      );
  }
}
