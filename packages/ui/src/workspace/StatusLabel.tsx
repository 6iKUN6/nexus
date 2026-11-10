import {
  IconCheckCircle,
  IconCloseCircle,
  IconExclamationCircle,
  IconPause,
} from '@arco-design/web-react/icon';
import type { ConversationState as RunState } from '@nexus/protocol';

/** Status always pairs an icon with text; color alone never carries meaning. */
const LABELS: Record<RunState, { text: string; className: string }> = {
  running: { text: '运行中', className: 'text-brand' },
  waiting_user: { text: '待你处理', className: 'text-warn' },
  idle: { text: '空闲', className: 'text-fg-3' },
  completed: { text: '已完成', className: 'text-ok' },
  failed: { text: '失败', className: 'text-bad' },
};

export function StatusIcon({ state }: { state: RunState }) {
  switch (state) {
    case 'running':
      return <span className="nx-pulse inline-block size-2 rounded-full bg-brand" />;
    case 'waiting_user':
      return <IconExclamationCircle className="text-warn" />;
    case 'completed':
      return <IconCheckCircle className="text-ok" />;
    case 'failed':
      return <IconCloseCircle className="text-bad" />;
    case 'idle':
      return <IconPause className="text-fg-3" />;
  }
}

export function StatusLabel({ state }: { state: RunState }) {
  const { text, className } = LABELS[state];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${className}`}>
      <StatusIcon state={state} />
      {text}
    </span>
  );
}
