import { Alert, Button, Form, Input, Modal, Radio } from '@arco-design/web-react';
import { IconFolderAdd } from '@arco-design/web-react/icon';
import type { HarnessId, HarnessInfo } from '@nexus/protocol';
import { useEffect, useState } from 'react';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

export type NewConversationInput = { harnessId: HarnessId; cwd: string; title?: string };

/** Pick a harness and a working directory. Only harnesses with an adapter can be chosen. */
export function NewConversationModal({
  visible,
  harnesses,
  defaultCwd,
  pickDirectory,
  onCancel,
  onCreate,
}: {
  visible: boolean;
  harnesses: HarnessInfo[] | null;
  defaultCwd: string | null;
  pickDirectory: (() => Promise<string | null>) | null;
  onCancel: () => void;
  onCreate: (input: NewConversationInput) => Promise<void>;
}) {
  const visibleHarnesses = (harnesses ?? []).filter((h) => h.id !== 'dsh');
  const firstSupported = visibleHarnesses.find((h) => h.chatSupported)?.id ?? null;
  const [harnessId, setHarnessId] = useState<HarnessId | null>(firstSupported);
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setHarnessId((current) => current ?? firstSupported);
    setCwd((current) => current || defaultCwd || '');
    setError(null);
  }, [visible, firstSupported, defaultCwd]);

  const submit = async () => {
    if (!harnessId || !cwd.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        harnessId,
        cwd: cwd.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setTitle('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新会话"
      visible={visible}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: !harnessId || !cwd.trim() }}
      onOk={() => void submit()}
      onCancel={onCancel}
      style={{ width: 520 }}
    >
      <Form layout="vertical" size="small">
        <Form.Item label="执行者" required>
          <Radio.Group
            value={harnessId ?? undefined}
            onChange={setHarnessId}
            className="flex flex-col gap-1.5"
          >
            {visibleHarnesses.map((h) => (
              <Radio key={h.id} value={h.id} disabled={!h.chatSupported}>
                <span className="inline-flex items-center gap-2">
                  <AgentAvatar agent={h.id} size="xs" />
                  {PERSONAS[h.id].name}
                  <span className="text-xs text-fg-3">
                    {!h.installed
                      ? '未安装'
                      : h.chatSupported
                        ? (h.version ?? '')
                        : '适配器将在 M2 提供'}
                  </span>
                </span>
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        <Form.Item
          label="工作目录"
          required
          extra="Agent 在这个目录中读写文件。M1 直接在此目录运行（worktree 隔离在 M2）。"
        >
          <div className="flex w-full gap-2">
            <Input
              value={cwd}
              onChange={setCwd}
              placeholder="/Users/you/code/project"
              className="font-mono"
            />
            {pickDirectory && (
              <Button
                icon={<IconFolderAdd />}
                onClick={() =>
                  void pickDirectory().then((path) => {
                    if (path) setCwd(path);
                  })
                }
              >
                选择…
              </Button>
            )}
          </div>
        </Form.Item>
        <Form.Item label="标题" extra="留空则用第一条消息作为标题">
          <Input
            value={title}
            onChange={setTitle}
            maxLength={120}
            placeholder="例如：修复登录跳转"
          />
        </Form.Item>
        {error && <Alert type="error" content={error} />}
      </Form>
    </Modal>
  );
}
