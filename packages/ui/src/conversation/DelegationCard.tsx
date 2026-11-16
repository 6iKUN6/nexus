import { Button, Input, Spin } from '@arco-design/web-react';
import { IconBranch, IconCheck, IconFile, IconUndo } from '@arco-design/web-react/icon';
import type { TaskEvidence, TaskStatus } from '@nexus/protocol';
import { useState } from 'react';
import type { TimelineItem } from '../model/types';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

type DelegationItem = Extract<TimelineItem, { kind: 'delegation' }>;

const STATUS_LABEL: Record<TaskStatus, { text: string; className: string }> = {
  running: { text: '进行中', className: 'bg-tint-2 text-brand' },
  review: { text: '待验收', className: 'bg-warn-soft text-warn' },
  accepted: { text: '已通过', className: 'bg-ok-soft text-ok' },
  failed: { text: '失败', className: 'bg-bad-soft text-bad' },
};

/**
 * Live progress card for a delegated sub-task (M3). The card is folded from
 * `task.delegated` + `task.updated` events, so it reflects every transition
 * without extra fetching. Review actions talk back to core; the inline
 * feedback form keeps the "request changes" flow in place.
 */
const FILE_STATUS_LABEL: Record<TaskEvidence['files'][number]['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
};

export function DelegationCard({
  item,
  onOpenConversation,
  onRespond,
  onLoadEvidence,
}: {
  item: DelegationItem;
  onOpenConversation: (conversationId: string) => void;
  onRespond: (taskId: string, action: 'accept' | 'request_changes', feedback?: string) => void;
  onLoadEvidence: (taskId: string) => Promise<TaskEvidence>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<TaskEvidence | 'loading' | 'error' | null>(null);
  const status = STATUS_LABEL[item.status];
  const persona = PERSONAS[item.harnessId];

  return (
    <section
      aria-label={`委派的子任务：${item.goal}`}
      className="rounded-lg border border-line-1 bg-elevated px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1 rounded bg-tint-2 px-1.5 py-0.5 font-medium text-fg-2">
          <IconBranch /> 委派
        </span>
        <AgentAvatar agent={item.harnessId} size="xs" />
        <span className="font-medium text-fg-1">{persona.name}</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] ${status.className}`}>
          {status.text}
        </span>
      </div>

      <p className="m-0 mt-1.5 text-[13px] font-medium text-fg-1">{item.goal}</p>
      {item.acceptance && (
        <p className="m-0 mt-1 whitespace-pre-wrap text-xs text-fg-3">
          验收标准：{item.acceptance}
        </p>
      )}

      {item.summary && item.status === 'running' && (
        <p className="m-0 mt-1.5 rounded bg-tint-1 px-2 py-1 text-xs text-fg-3">
          退回反馈：{item.summary}
        </p>
      )}
      {item.summary && (item.status === 'review' || item.status === 'accepted') && (
        <div className="mt-1.5 max-h-40 overflow-y-auto rounded bg-tint-1 px-2 py-1.5">
          <div className="text-[11px] font-medium text-fg-3">子任务结果</div>
          <p className="nx-selectable m-0 mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-fg-1">
            {item.summary}
          </p>
        </div>
      )}
      {item.summary && item.status === 'failed' && (
        <p className="m-0 mt-1.5 rounded bg-bad-soft px-2 py-1 text-xs text-bad">{item.summary}</p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Button size="mini" onClick={() => onOpenConversation(item.childConversationId)}>
          打开子会话
        </Button>
        <Button
          size="mini"
          type="text"
          icon={<IconFile />}
          aria-expanded={evidenceOpen}
          onClick={() => {
            const next = !evidenceOpen;
            setEvidenceOpen(next);
            // Reload on every open: the worktree keeps changing while the
            // task runs, and stale evidence is worse than a fresh fetch.
            if (next) {
              setEvidence('loading');
              onLoadEvidence(item.taskId).then(setEvidence, () => setEvidence('error'));
            }
          }}
        >
          查看改动
        </Button>
        {item.status === 'review' && (
          <>
            <Button
              size="mini"
              type="primary"
              icon={<IconCheck />}
              onClick={() => onRespond(item.taskId, 'accept')}
            >
              验收通过
            </Button>
            <Button size="mini" icon={<IconUndo />} onClick={() => setRejecting(true)}>
              退回修改
            </Button>
          </>
        )}
        {item.status === 'failed' && (
          <Button size="mini" icon={<IconUndo />} onClick={() => setRejecting(true)}>
            退回重做
          </Button>
        )}
      </div>

      {evidenceOpen && (
        <div className="mt-2 rounded border border-line-1 bg-surface-2 p-2">
          {evidence === 'loading' && (
            <div className="flex justify-center py-2">
              <Spin size={14} />
            </div>
          )}
          {evidence === 'error' && <p className="m-0 text-xs text-fg-3">读取改动失败，请重试。</p>}
          {evidence !== null && evidence !== 'loading' && evidence !== 'error' && (
            <EvidenceView evidence={evidence} />
          )}
        </div>
      )}

      {rejecting && (
        <div className="mt-2 flex flex-col gap-1.5 rounded border border-line-1 bg-surface-2 p-2">
          <Input.TextArea
            value={feedback}
            onChange={setFeedback}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="告诉子任务哪里不符合验收标准…"
            aria-label="退回反馈"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="mini" onClick={() => setRejecting(false)}>
              取消
            </Button>
            <Button
              size="mini"
              type="primary"
              status="warning"
              disabled={!feedback.trim()}
              onClick={() => {
                onRespond(item.taskId, 'request_changes', feedback.trim());
                setRejecting(false);
                setFeedback('');
              }}
            >
              发送退回
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function EvidenceView({ evidence }: { evidence: TaskEvidence }) {
  const [diffOpen, setDiffOpen] = useState(false);
  if (!evidence.available) {
    return <p className="m-0 text-xs text-fg-3">{evidence.problem ?? '无法读取改动'}</p>;
  }
  const empty = evidence.files.length === 0 && evidence.untracked.length === 0;
  return (
    <div className="flex flex-col gap-1.5">
      {empty && <p className="m-0 text-xs text-fg-3">工作区没有改动。</p>}
      {evidence.files.map((file) => (
        <div key={file.path} className="flex items-center gap-2 text-xs">
          <span className="rounded bg-tint-2 px-1 py-0.5 text-[11px] text-fg-2">
            {FILE_STATUS_LABEL[file.status]}
          </span>
          <span className="nx-selectable min-w-0 flex-1 truncate font-mono text-[11px] text-fg-1">
            {file.path}
          </span>
          {(file.added !== null || file.deleted !== null) && (
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-ok">+{file.added ?? 0}</span>
              <span className="text-fg-3"> / </span>
              <span className="text-bad">−{file.deleted ?? 0}</span>
            </span>
          )}
        </div>
      ))}
      {evidence.untracked.map((file) => (
        <div key={file} className="flex items-center gap-2 text-xs">
          <span className="rounded bg-tint-2 px-1 py-0.5 text-[11px] text-fg-2">新增</span>
          <span className="nx-selectable min-w-0 flex-1 truncate font-mono text-[11px] text-fg-1">
            {file}
          </span>
          <span className="shrink-0 text-[11px] text-fg-3">未跟踪</span>
        </div>
      ))}
      {evidence.secretFilesOmitted > 0 && (
        <p className="m-0 text-[11px] text-fg-3">
          已省略 {evidence.secretFilesOmitted} 个疑似密钥文件。
        </p>
      )}
      {evidence.diff && (
        <div>
          <Button
            size="mini"
            type="text"
            aria-expanded={diffOpen}
            onClick={() => setDiffOpen(!diffOpen)}
          >
            {diffOpen ? '收起 diff' : '展开 diff'}
            {evidence.diffTruncated ? '（已截断）' : ''}
          </Button>
          {diffOpen && (
            <pre className="nx-selectable m-0 mt-1 max-h-64 overflow-auto rounded bg-tint-1 p-2 font-mono text-[11px] leading-relaxed text-fg-2">
              {evidence.diff}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
