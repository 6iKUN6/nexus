import { Button, Input, Tooltip } from '@arco-design/web-react';
import {
  IconFolder,
  IconMindMapping,
  IconRecordStop,
  IconSend,
  IconSwap,
} from '@arco-design/web-react/icon';
import type { Conversation } from '@nexus/protocol';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

type ComposerProps = {
  conversation: Conversation;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** 'delegate' opens the real dialog (M3); 'handoff' opens the M4 design preview. */
  onCollaboration: (kind: 'delegate' | 'handoff') => void;
};

const busyStates = new Set<Conversation['state']>(['running', 'waiting_user']);

/**
 * Recipient and working directory sit above the input so a message is never
 * sent to the wrong task. Enter sends, Shift+Enter breaks the line, and Enter
 * during IME composition (Chinese input) only confirms the candidate.
 */
export function Composer(props: ComposerProps) {
  const { conversation } = props;
  const persona = PERSONAS[conversation.harnessId];
  const busy = busyStates.has(conversation.state);
  const canSend = props.draft.trim().length > 0;

  return (
    <div className="shrink-0 px-6 pt-1 pb-4">
      <div className="mx-auto max-w-[780px] rounded-xl border border-line-2 bg-elevated shadow-mac focus-within:border-brand">
        <div className="flex items-center gap-3 px-3 pt-2 text-xs text-fg-3">
          <span className="flex items-center gap-1.5">
            发给
            <AgentAvatar agent={conversation.harnessId} size="xs" />
            <span className="font-medium text-fg-1">{persona.name}</span>
          </span>
          <Tooltip content={conversation.cwd} mini>
            <span className="flex min-w-0 items-center gap-1">
              <IconFolder />
              <span className="truncate font-mono text-[11px]">{conversation.cwd}</span>
            </span>
          </Tooltip>
          {busy && <span className="ml-auto shrink-0 text-warn">运行中 · 新消息会排队发送</span>}
        </div>

        <Input.TextArea
          value={props.draft}
          onChange={props.onDraftChange}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={`给 ${persona.name} 发消息…`}
          aria-label="消息"
          className="border-none bg-transparent px-3 shadow-none"
          onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) props.onSend();
          }}
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <Tooltip content="把一部分工作委派给另一个 Agent 的子会话" mini>
            <Button
              size="small"
              type="text"
              icon={<IconMindMapping />}
              onClick={() => props.onCollaboration('delegate')}
            >
              委派
            </Button>
          </Tooltip>
          <Tooltip content="M4 开放：预览交接流程" mini>
            <Button
              size="small"
              type="text"
              icon={<IconSwap />}
              onClick={() => props.onCollaboration('handoff')}
            >
              交接
            </Button>
          </Tooltip>
          <span className="ml-auto pr-2 text-[11px] text-fg-4">⏎ 发送 · ⇧⏎ 换行</span>
          {busy && (
            <Button size="small" status="danger" icon={<IconRecordStop />} onClick={props.onStop}>
              停止
            </Button>
          )}
          <Button
            size="small"
            type="primary"
            icon={<IconSend />}
            disabled={!canSend}
            onClick={props.onSend}
          >
            {busy ? '排队发送' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  );
}
