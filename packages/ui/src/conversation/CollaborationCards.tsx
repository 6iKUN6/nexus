import { Button } from '@arco-design/web-react';
import { IconMessage, IconSwap } from '@arco-design/web-react/icon';
import type { TimelineItem } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

type Of<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;

/**
 * A message an agent sent through the collaboration channel (D14). It is
 * deliberately not a chat bubble: the user did not write it, and it must not
 * look like something they can reply to as themselves.
 */
export function AgentMessageCard({
  item,
  onOpenConversation,
}: {
  item: Of<'agentMessage'>;
  onOpenConversation: (id: string) => void;
}) {
  const out = item.direction === 'out';
  return (
    <section
      aria-label={`协作消息：${item.text.slice(0, 40)}`}
      className="rounded-lg border border-line-1 bg-elevated px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs text-fg-2">
        <span className="flex items-center gap-1 rounded bg-tint-2 px-1.5 py-0.5 font-medium">
          <IconMessage /> {out ? '发送给委派方' : '子任务消息'}
        </span>
        <Button
          type="text"
          size="mini"
          className="ml-auto text-fg-3"
          onClick={() => onOpenConversation(item.peerConversationId)}
        >
          查看会话
        </Button>
      </div>
      <p className="nx-selectable m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-1">
        {item.text}
      </p>
    </section>
  );
}

/**
 * The agent asked to be handed to another harness (D14). Only a request: the
 * dialog opens prefilled and the user decides whether the handoff happens.
 */
export function HandoffRequestCard({
  item,
  onRequest,
}: {
  item: Of<'handoffRequest'>;
  onRequest: (toHarnessId: Of<'handoffRequest'>['toHarnessId']) => void;
}) {
  return (
    <section aria-label="交接请求" className="rounded-lg border border-warn bg-elevated px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-fg-2">
        <span className="flex items-center gap-1 rounded bg-warn-soft px-1.5 py-0.5 font-medium text-warn">
          <IconSwap /> 交接请求
        </span>
        <AgentAvatar agent={item.toHarnessId} size="xs" />
        <Button
          type="primary"
          size="mini"
          className="ml-auto"
          onClick={() => onRequest(item.toHarnessId)}
        >
          打开交接
        </Button>
      </div>
      <p className="nx-selectable m-0 mt-1.5 whitespace-pre-wrap text-[13px] text-fg-1">
        {item.reason}
      </p>
    </section>
  );
}
