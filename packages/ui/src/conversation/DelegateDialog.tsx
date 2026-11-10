import { Alert, Button, Form, Input, Modal, Select } from '@arco-design/web-react';
import type { Conversation, HarnessId, HarnessInfo } from '@nexus/protocol';
import { useEffect, useState } from 'react';
import { PERSONAS } from '../model/types';

export type DelegateInput = {
  goal: string;
  acceptance: string | null;
  harnessId: HarnessId;
};

/**
 * Real delegation dialog (M3). Creates a worktree-isolated child conversation
 * via `task.delegate`. The workspace is fixed to a fresh worktree of the
 * parent's repository: the preview's "shared read-only" option was dropped
 * because read-only cannot be enforced at the filesystem level.
 */
export function DelegateDialog({
  conversation,
  harnesses,
  visible,
  onCancel,
  onDelegate,
}: {
  conversation: Conversation;
  harnesses: HarnessInfo[] | null;
  visible: boolean;
  onCancel: () => void;
  onDelegate: (input: DelegateInput) => Promise<void>;
}) {
  const [goal, setGoal] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const supported = (harnesses ?? []).filter((h) => h.chatSupported);
  const fallback =
    supported.find((h) => h.id !== conversation.harnessId)?.id ?? conversation.harnessId;
  const [harnessId, setHarnessId] = useState<HarnessId>(fallback);

  // Reset the form for each opening; default to a different harness (a second
  // pair of eyes), falling back to the parent's own. `fallback` is intentionally
  // captured at open time only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fallback derives from props at open time
  useEffect(() => {
    if (visible) {
      setGoal('');
      setAcceptance('');
      setHarnessId(fallback);
      setSubmitting(false);
    }
  }, [visible]);

  const base = conversation.baseCwd ?? conversation.cwd;
  const canSubmit = goal.trim().length > 0 && !submitting;

  return (
    <Modal
      title="委派子任务"
      visible={visible}
      footer={null}
      onCancel={onCancel}
      style={{ width: 520 }}
    >
      <Form layout="vertical" size="small">
        <Form.Item label="子任务目标" required>
          <Input
            value={goal}
            onChange={setGoal}
            placeholder="例如：为 returnTo 校验补充单元测试"
            maxLength={500}
          />
        </Form.Item>
        <Form.Item label="验收标准（可选，每行一条）">
          <Input.TextArea
            value={acceptance}
            onChange={setAcceptance}
            placeholder="每行一条"
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={2000}
          />
        </Form.Item>
        <Form.Item label="执行者">
          <Select
            value={harnessId}
            onChange={(value) => setHarnessId(value as HarnessId)}
            options={supported.map((h) => ({ label: PERSONAS[h.id].name, value: h.id }))}
          />
        </Form.Item>
        <Alert
          type="info"
          content={`子任务在 ${base} 的独立 worktree 中进行，与当前会话互不影响；完成后结果会回到这里待你验收。`}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            disabled={!canSubmit}
            loading={submitting}
            onClick={() => {
              setSubmitting(true);
              void onDelegate({
                goal: goal.trim(),
                acceptance: acceptance.trim() || null,
                harnessId,
              }).catch(() => setSubmitting(false));
            }}
          >
            创建子任务
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
