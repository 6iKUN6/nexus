import { Button, Tooltip } from '@arco-design/web-react';
import { IconFolder, IconLayout, IconRecordStop } from '@arco-design/web-react/icon';
import type { Conversation } from '@nexus/protocol';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';
import { StatusLabel } from '../workspace/StatusLabel';

/** Who runs the conversation, where it works and what state it is in — always visible. */
export function ConversationHeader({
  conversation,
  detailOpen,
  onToggleDetail,
  onStop,
}: {
  conversation: Conversation;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onStop: () => void;
}) {
  const busy = conversation.state === 'running' || conversation.state === 'waiting_user';
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line-1 px-5 py-2.5">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 truncate text-[15px] font-semibold text-fg-1">{conversation.title}</h1>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-3">
          <span className="flex shrink-0 items-center gap-1">
            <AgentAvatar agent={conversation.harnessId} size="xs" />
            <span className="text-fg-2">{PERSONAS[conversation.harnessId].name}</span>
          </span>
          <Tooltip content={conversation.cwd} mini>
            <span className="flex min-w-0 items-center gap-1">
              <IconFolder />
              <span className="truncate font-mono text-[11px]">{conversation.cwd}</span>
            </span>
          </Tooltip>
          <StatusLabel state={conversation.state} />
        </div>
      </div>
      {busy && (
        <Button size="small" status="danger" icon={<IconRecordStop />} onClick={onStop}>
          停止运行
        </Button>
      )}
      <Tooltip content={detailOpen ? '隐藏详情' : '显示详情'} mini>
        <Button
          size="small"
          type={detailOpen ? 'secondary' : 'text'}
          icon={<IconLayout />}
          aria-pressed={detailOpen}
          aria-label="详情面板"
          onClick={onToggleDetail}
        />
      </Tooltip>
    </header>
  );
}
