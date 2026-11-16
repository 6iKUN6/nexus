import { Button } from '@arco-design/web-react';
import { IconLaunch, IconMessage, IconPublic, IconSwap } from '@arco-design/web-react/icon';
import { type MessageRecord, type MessageState, normalizeLocalUrl } from '@nexus/protocol';
import type { TimelineItem } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

type Of<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;

const STATE_LABEL: Record<MessageState, string> = {
  queued: '已入队',
  delivered: '已投递',
  consumed: '已确认收到',
  replied: '已回复',
  failed: '发送失败',
  needs_check: '需核对',
};

/**
 * A message an agent sent through the collaboration channel (D14). It is
 * deliberately not a chat bubble: the user did not write it, and it must not
 * look like something they can reply to as themselves.
 */
export function AgentMessageCard({
  item,
  message,
  onOpenConversation,
  onResend,
}: {
  item: Of<'agentMessage'>;
  /** Delivery state from the messages table (D15); absent while loading. */
  message: MessageRecord | null;
  onOpenConversation: (id: string) => void;
  onResend: (messageId: string) => void;
}) {
  const out = item.direction === 'out';
  const failed = message?.state === 'needs_check' || message?.state === 'failed';
  return (
    <section
      aria-label={`协作消息：${item.text.slice(0, 40)}`}
      className={`rounded-lg border px-3 py-2 ${failed ? 'border-warn bg-elevated' : 'border-line-1 bg-elevated'}`}
    >
      <div className="flex items-center gap-2 text-xs text-fg-2">
        <span className="flex items-center gap-1 rounded bg-tint-2 px-1.5 py-0.5 font-medium">
          <IconMessage /> {out ? '发送给委派方' : '子任务消息'}
        </span>
        {out && message && (
          <span
            className={
              failed
                ? 'rounded bg-warn-soft px-1.5 py-0.5 text-warn'
                : 'rounded bg-tint-1 px-1.5 py-0.5 text-fg-3'
            }
          >
            {STATE_LABEL[message.state]}
          </span>
        )}
        {out && failed && (
          <Button type="text" size="mini" onClick={() => onResend(item.messageId)}>
            重发
          </Button>
        )}
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

/**
 * An agent asked to show a localhost page (ADR 0019). The card is the confirm
 * point: nothing opens until the user clicks, and it stays clickable so the
 * preview can be reopened later.
 */
export function PreviewRequestCard({
  item,
  onOpenLocalUrl,
}: {
  item: Of<'previewRequest'>;
  onOpenLocalUrl: (url: string) => void;
}) {
  // Local addresses can be embedded; anything else (ADR 0014 whitelist) only
  // gets the system-browser route. Nothing opens until the user clicks.
  const previewable = normalizeLocalUrl(item.url) !== null;
  return (
    <section
      aria-label={`预览请求：${item.url}`}
      className="rounded-lg border border-line-1 bg-elevated px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1 rounded bg-tint-2 px-1.5 py-0.5 font-medium text-fg-2">
          <IconPublic /> 预览请求
        </span>
        <span className="nx-selectable min-w-0 flex-1 truncate font-mono text-[11px] text-fg-1">
          {item.url}
        </span>
        {previewable ? (
          <>
            <Button
              type="primary"
              size="mini"
              icon={<IconPublic />}
              onClick={() => onOpenLocalUrl(item.url)}
            >
              打开预览
            </Button>
            <Button
              type="text"
              size="mini"
              icon={<IconLaunch />}
              aria-label="在浏览器中打开"
              onClick={() => window.open(item.url, '_blank')}
            />
          </>
        ) : (
          <Button
            type="primary"
            size="mini"
            icon={<IconLaunch />}
            onClick={() => window.open(item.url, '_blank')}
          >
            在浏览器打开
          </Button>
        )}
      </div>
      {!previewable && (
        <p className="m-0 mt-1 text-[11px] text-fg-3">
          内置预览仅支持本机地址，外部网页请用系统浏览器打开。
        </p>
      )}
    </section>
  );
}
