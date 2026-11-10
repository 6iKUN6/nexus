import { Alert, Drawer, Form, Input, Modal, Radio, Select } from '@arco-design/web-react';
import {
  IconCheckCircle,
  IconExclamationCircle,
  IconMinusCircle,
} from '@arco-design/web-react/icon';
import type { Conversation, HarnessId } from '@nexus/protocol';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

/**
 * Design previews of delegation (M3) and handoff (M4), kept reachable so the
 * flows can be reviewed in the real app. Nothing here is submitted; contents
 * are illustrative examples, labelled as such.
 */

const OTHERS: HarnessId[] = ['claude-code', 'codex', 'pi'];

export function CollaborationPreview({
  kind,
  conversation,
  onClose,
}: {
  kind: 'delegate' | 'handoff' | null;
  conversation: Conversation;
  onClose: () => void;
}) {
  return (
    <>
      <HandoffPreview conversation={conversation} visible={kind === 'handoff'} onClose={onClose} />
      <DelegatePreview
        conversation={conversation}
        visible={kind === 'delegate'}
        onClose={onClose}
      />
    </>
  );
}

function HandoffPreview({
  conversation,
  visible,
  onClose,
}: {
  conversation: Conversation;
  visible: boolean;
  onClose: () => void;
}) {
  const from = conversation.harnessId;
  const to = OTHERS.find((h) => h !== from) ?? 'codex';
  return (
    <Drawer width={460} visible={visible} title="交接任务" footer={null} onCancel={onClose}>
      <div className="flex flex-col gap-4 text-[13px]">
        <Alert type="info" content="功能预览：交接将在 M4 开放。下面的内容是示例，不会被提交。" />
        <div className="flex items-center gap-2 rounded-lg bg-tint-1 px-3 py-2.5">
          <AgentAvatar agent={from} size="sm" />
          <span className="font-medium">{PERSONAS[from].name}</span>
          <span className="text-fg-3">→</span>
          <AgentAvatar agent={to} size="sm" />
          <span className="font-medium">{PERSONAS[to].name}</span>
          <span className="ml-auto text-xs text-fg-3">精简交接 · 新会话</span>
        </div>

        <PreviewSection title="必带要求" note="来自你的原话，不会被摘要改写">
          <Kept source="m1">保持现有接口兼容</Kept>
        </PreviewSection>
        <PreviewSection title="已确认的事实">
          <Kept source="t2">（示例）问题出在回调里固定跳转到首页</Kept>
        </PreviewSection>
        <PreviewSection title="未验证的假设">
          <Hypothesis>（示例）其他路由守卫可能有同样问题</Hypothesis>
        </PreviewSection>
        <PreviewSection title="文件与工作区">
          <Kept source="git">基准提交 · 未提交改动 · 未跟踪文件清单</Kept>
        </PreviewSection>
        <PreviewSection title="省略的内容" note="接收方可以按需读取原会话">
          <Omitted reason="与下一步无关">完整的搜索输出</Omitted>
          <Omitted reason="可能含密钥，默认不打包">.env.local</Omitted>
        </PreviewSection>

        <div className="rounded-lg border border-warn bg-warn-soft px-3 py-2 text-xs text-fg-1">
          交接前会先停止 {PERSONAS[from].name} 并确认其进程已全部退出；无法确认时交接会被阻止。
        </div>
      </div>
    </Drawer>
  );
}

function PreviewSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className="m-0 mb-1.5 flex items-baseline gap-2 text-xs font-semibold text-fg-2">
        {title}
        {note && <span className="font-normal text-fg-3">{note}</span>}
      </h4>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">{children}</ul>
    </section>
  );
}

function Kept({ children, source }: { children: React.ReactNode; source: string }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <IconCheckCircle className="mt-0.5 shrink-0 text-ok" />
      <span className="flex-1 text-fg-1">{children}</span>
      <span className="shrink-0 font-mono text-[10px] text-fg-4">来源 {source}</span>
    </li>
  );
}

function Hypothesis({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <IconExclamationCircle className="mt-0.5 shrink-0 text-warn" />
      <span className="text-fg-1">{children}</span>
    </li>
  );
}

function Omitted({ children, reason }: { children: React.ReactNode; reason: string }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <IconMinusCircle className="mt-0.5 shrink-0 text-fg-3" />
      <span className="flex-1 text-fg-2">{children}</span>
      <span className="shrink-0 text-[11px] text-fg-3">{reason}</span>
    </li>
  );
}

function DelegatePreview({
  conversation,
  visible,
  onClose,
}: {
  conversation: Conversation;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      title="委派子任务"
      visible={visible}
      footer={null}
      onCancel={onClose}
      style={{ width: 520 }}
    >
      <Alert className="mb-4" type="info" content="功能预览：委派将在 M3 开放，当前无法提交。" />
      <Form layout="vertical" size="small" disabled>
        <Form.Item label="子任务目标" required>
          <Input placeholder="例如：为 returnTo 校验补充单元测试" />
        </Form.Item>
        <Form.Item label="验收标准">
          <Input.TextArea placeholder="每行一条" autoSize={{ minRows: 2, maxRows: 4 }} />
        </Form.Item>
        <Form.Item label="执行者">
          <Select
            placeholder="选择执行者"
            options={OTHERS.filter((h) => h !== conversation.harnessId).map((h) => ({
              label: PERSONAS[h].name,
              value: h,
            }))}
          />
        </Form.Item>
        <Form.Item label="工作区">
          <Radio.Group type="button" defaultValue="readonly">
            <Radio value="readonly">共享 · 只读</Radio>
            <Radio value="worktree">新建 worktree · 可写</Radio>
          </Radio.Group>
        </Form.Item>
      </Form>
    </Modal>
  );
}
