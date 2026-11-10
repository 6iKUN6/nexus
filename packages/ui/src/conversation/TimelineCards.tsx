import { Button, Spin, Tooltip } from '@arco-design/web-react';
import {
  IconCheck,
  IconCheckCircle,
  IconCloseCircle,
  IconDown,
  IconExclamationCircle,
  IconLock,
  IconQuestionCircle,
  IconRight,
} from '@arco-design/web-react/icon';
import type { HarnessId, PermissionOption } from '@nexus/protocol';
import { useState } from 'react';
import { failureTitle } from '../model/buildTimeline';
import { PERSONAS, type TimelineItem } from '../model/types';

type Of<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;

/** Shared frame: cards are visually distinct from chat bubbles so tool noise never reads as a reply. */
function Card({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warn' | 'bad';
  children: React.ReactNode;
}) {
  const border = { neutral: 'border-line-2', warn: 'border-warn', bad: 'border-bad' }[tone];
  return (
    <div className={`overflow-hidden rounded-lg border bg-elevated shadow-mac ${border}`}>
      {children}
    </div>
  );
}

const TOOL_STATUS: Record<Of<'tool'>['status'], { icon: React.ReactNode; label: string }> = {
  running: { icon: <Spin size={12} />, label: '运行中' },
  ok: { icon: <IconCheck className="text-ok" />, label: '成功' },
  error: { icon: <IconCloseCircle className="text-bad" />, label: '失败' },
  // The run ended before the tool reported back: we don't know what happened.
  unknown: { icon: <IconQuestionCircle className="text-warn" />, label: '结果未知' },
};

export function ToolCard({ item }: { item: Of<'tool'> }) {
  const [open, setOpen] = useState(false);
  const status = TOOL_STATUS[item.status];
  return (
    <div className="rounded-md bg-tint-1">
      <Button
        long
        type="text"
        size="small"
        aria-expanded={open}
        disabled={!item.output}
        onClick={() => setOpen(!open)}
        className="flex h-auto items-center gap-2 px-2.5 py-1.5 text-left text-fg-2"
      >
        <span className="flex size-3.5 items-center justify-center" title={status.label}>
          {status.icon}
        </span>
        <span className="sr-only">{status.label}</span>
        <span className="text-xs font-medium text-fg-1">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3">
          {item.detail}
        </span>
        {item.output && (open ? <IconDown /> : <IconRight />)}
      </Button>
      {open && item.output && (
        <pre className="nx-selectable m-0 overflow-x-auto border-t border-line-1 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">
          {item.output}
        </pre>
      )}
    </div>
  );
}

export function PermissionCard({
  item,
  agent,
  onRespond,
}: {
  item: Of<'permission'>;
  agent: HarnessId;
  onRespond: (option: PermissionOption) => void;
}) {
  const persona = PERSONAS[agent];
  if (item.state !== 'pending') {
    const allowed = item.chosen?.kind.startsWith('allow');
    return (
      <div className="flex items-center gap-2 px-1 text-xs text-fg-3">
        {item.state === 'expired' ? (
          <IconQuestionCircle />
        ) : allowed ? (
          <IconCheckCircle className="text-ok" />
        ) : (
          <IconCloseCircle />
        )}
        <span className="min-w-0 truncate">
          {item.state === 'expired'
            ? '权限请求已失效（运行已结束）'
            : `你选择了「${item.chosen?.label ?? '未知'}」`}
          ：{item.description}
        </span>
      </div>
    );
  }
  // Decline first, the primary action last (macOS order); no keyboard shortcut approves.
  const ordered = [...item.options].sort((a, b) => rank(a) - rank(b));
  return (
    <Card tone="warn">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn">
          <IconLock />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg-1">{persona.name} 请求权限</div>
          <div className="nx-selectable mt-0.5 text-xs break-all text-fg-2">{item.description}</div>
          <div className="mt-1 text-[11px] text-fg-3">
            只对这一个请求生效；切换 Tab 不会改变批准的对象。
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line-1 bg-tint-1 px-3.5 py-2">
        {ordered.map((option) => (
          <Button
            key={option.id}
            size="small"
            type={option.kind === 'allow_once' ? 'primary' : 'secondary'}
            onClick={() => onRespond(option)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function rank(option: PermissionOption): number {
  return { reject_once: 0, reject_always: 1, allow_always: 2, allow_once: 3 }[option.kind];
}

export function FailureCard({
  item,
  onRetry,
}: {
  item: Of<'failure'>;
  onRetry: (() => void) | null;
}) {
  return (
    <Card tone="bad">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad">
          <IconExclamationCircle />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg-1">{failureTitle(item.code)}</div>
          <div className="nx-selectable mt-0.5 text-xs break-words whitespace-pre-wrap text-fg-2">
            {item.message}
          </div>
          <div className="mt-1 font-mono text-[10px] text-fg-4">{item.code}</div>
        </div>
        {onRetry && (
          <Tooltip content="重新发送上一条消息（不会自动重放已执行的操作）" mini>
            <Button size="small" type="primary" onClick={onRetry}>
              重试
            </Button>
          </Tooltip>
        )}
      </div>
    </Card>
  );
}
