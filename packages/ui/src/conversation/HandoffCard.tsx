import { IconCheckCircle, IconExclamationCircle, IconSwap } from '@arco-design/web-react/icon';
import { PERSONAS, type TimelineItem } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

type HandoffItem = Extract<TimelineItem, { kind: 'handoff' }>;

/**
 * Result of a handoff (M4). Only final states reach the log: `committed` is
 * informational (the receiver's own messages follow), while `aborted` and
 * `needs_reconciliation` must say what happened and who is in charge now.
 */
export function HandoffCard({ item }: { item: HandoffItem }) {
  const from = PERSONAS[item.fromHarnessId];
  const to = PERSONAS[item.toHarnessId];
  const failed = item.state !== 'committed';
  return (
    <section
      aria-label={`交接：${item.goal}`}
      className={`rounded-lg border bg-elevated px-3 py-2 ${failed ? 'border-warn' : 'border-line-1'}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1 rounded bg-tint-2 px-1.5 py-0.5 font-medium text-fg-2">
          <IconSwap /> 交接
        </span>
        <AgentAvatar agent={item.fromHarnessId} size="xs" />
        <span className="text-fg-1">{from.name}</span>
        <span className="text-fg-3">→</span>
        <AgentAvatar agent={item.toHarnessId} size="xs" />
        <span className="text-fg-1">{to.name}</span>
        <span className="ml-auto flex items-center gap-1">
          {failed ? (
            <IconExclamationCircle className="text-warn" />
          ) : (
            <IconCheckCircle className="text-ok" />
          )}
          <span className={failed ? 'text-warn' : 'text-ok'}>{STATE_LABEL[item.state]}</span>
        </span>
      </div>
      <p className="m-0 mt-1.5 text-[13px] text-fg-1">{item.goal}</p>
      {item.problem && (
        <p className="nx-selectable m-0 mt-1 whitespace-pre-wrap text-xs text-fg-2">
          {item.problem}
        </p>
      )}
    </section>
  );
}

const STATE_LABEL: Record<HandoffItem['state'], string> = {
  committed: '已交接',
  aborted: '未完成',
  needs_reconciliation: '需核对',
};
