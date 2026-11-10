import { Alert, Button, Form, Input, Modal, Radio, Tooltip } from '@arco-design/web-react';
import { IconFolderAdd, IconInfoCircle } from '@arco-design/web-react/icon';
import type { HarnessId, HarnessInfo, Isolation, RpcResult } from '@nexus/protocol';
import { useEffect, useRef, useState } from 'react';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

export type NewConversationInput = {
  harnessId: HarnessId;
  cwd: string;
  isolation: Isolation;
  title?: string;
};

type PathInfo = RpcResult<'path.inspect'>;

/** Pick a harness and a working directory. Only harnesses with an adapter can be chosen. */
export function NewConversationModal({
  visible,
  harnesses,
  defaultCwd,
  pickDirectory,
  inspectPath,
  onCancel,
  onCreate,
}: {
  visible: boolean;
  harnesses: HarnessInfo[] | null;
  defaultCwd: string | null;
  pickDirectory: (() => Promise<string | null>) | null;
  inspectPath: (cwd: string) => Promise<PathInfo>;
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
  const [inspect, setInspect] = useState<PathInfo | null>(null);
  const [isolation, setIsolation] = useState<Isolation>('direct');
  // The default follows the inspect result until the user picks explicitly.
  const isolationTouched = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setHarnessId((current) => current ?? firstSupported);
    setCwd((current) => current || defaultCwd || '');
    setError(null);
    isolationTouched.current = false;
  }, [visible, firstSupported, defaultCwd]);

  useEffect(() => {
    const path = cwd.trim();
    if (!visible || !path) {
      setInspect(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      inspectPath(path)
        .then((info) => {
          if (stale) return;
          setInspect(info);
          if (!isolationTouched.current) setIsolation(info.isGitRepo ? 'worktree' : 'direct');
        })
        .catch(() => {
          if (!stale) setInspect(null);
        });
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [visible, cwd, inspectPath]);

  const worktreeDisabledReason = inspect
    ? !inspect.exists
      ? '目录不存在'
      : !inspect.isGitRepo
        ? '不是 git 仓库'
        : null
    : null;

  const submit = async () => {
    if (!harnessId || !cwd.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        harnessId,
        cwd: cwd.trim(),
        isolation,
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
        <Form.Item label="工作目录" required>
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
        <Form.Item label="运行位置">
          <Radio.Group
            value={isolation}
            onChange={(value) => {
              isolationTouched.current = true;
              setIsolation(value);
            }}
            className="flex flex-col gap-1.5"
          >
            <Radio value="worktree" disabled={worktreeDisabledReason !== null}>
              <span className="inline-flex items-center gap-1.5">
                独立 worktree（推荐）
                {worktreeDisabledReason && (
                  <Tooltip content={`无法使用：${worktreeDisabledReason}`} mini>
                    <IconInfoCircle className="text-fg-3" />
                  </Tooltip>
                )}
              </span>
            </Radio>
            <Radio value="direct" disabled={inspect?.directInUse === true}>
              直接在此目录运行
            </Radio>
          </Radio.Group>
          <div className="mt-1.5 text-xs leading-relaxed text-fg-3">
            {isolation === 'worktree' && worktreeDisabledReason === null
              ? '在仓库的独立副本中运行，不影响你的工作区；产物保留在应用数据目录的 worktrees 下。'
              : inspect?.directInUse
                ? '已有会话直接在此目录运行。为避免两个 Agent 同时改写同一目录，请改用 worktree。'
                : '改动会直接写入这个目录。'}
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
