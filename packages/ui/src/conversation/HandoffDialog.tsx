import { Alert, Button, Drawer, Form, Input, Select, Tag } from '@arco-design/web-react';
import {
  IconCheckCircle,
  IconExclamationCircle,
  IconMinusCircle,
} from '@arco-design/web-react/icon';
import type {
  Conversation,
  Handoff,
  HandoffPackage,
  HarnessId,
  HarnessInfo,
} from '@nexus/protocol';
import { useEffect, useState } from 'react';
import { PERSONAS } from '../model/types';
import { AgentAvatar } from '../workspace/AgentAvatar';

export type HandoffDraft = {
  toHarnessId: HarnessId;
  goal: string;
  nextAction: string;
  facts: string[];
  assumptions: string[];
};

/** Lines of a textarea → trimmed non-empty entries. */
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Handoff (M4, ADR 0011). Step 1 stops the source agent (that is what
 * `prepare` does, and it is stated up front), step 2 shows the frozen package
 * for review; only confirming changes the owner. A blocked stop leaves a
 * problem the user can read verbatim.
 */
export function HandoffDialog({
  conversation,
  harnesses,
  visible,
  onClose,
  onPrepare,
  onCommit,
  onCancelHandoff,
}: {
  conversation: Conversation;
  harnesses: HarnessInfo[] | null;
  visible: boolean;
  onClose: () => void;
  onPrepare: (draft: HandoffDraft) => Promise<Handoff>;
  onCommit: (handoff: Handoff) => Promise<void>;
  onCancelHandoff: (handoff: Handoff) => Promise<void>;
}) {
  const candidates = (harnesses ?? []).filter(
    (h) => h.chatSupported && h.id !== conversation.harnessId,
  );
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'commit' | 'cancel' | null>(null);
  const [goal, setGoal] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [facts, setFacts] = useState('');
  const [assumptions, setAssumptions] = useState('');
  const first = candidates[0]?.id ?? conversation.harnessId;
  const [toHarnessId, setToHarnessId] = useState<HarnessId>(first);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per opening only
  useEffect(() => {
    if (!visible) return;
    setHandoff(null);
    setProblem(null);
    setBusy(null);
    setGoal(conversation.title === '新会话' ? '' : conversation.title);
    setNextAction('');
    setFacts('');
    setAssumptions('');
    setToHarnessId(first);
  }, [visible]);

  const prepare = async () => {
    setBusy('prepare');
    setProblem(null);
    try {
      setHandoff(
        await onPrepare({
          toHarnessId,
          goal: goal.trim(),
          nextAction: nextAction.trim(),
          facts: lines(facts),
          assumptions: lines(assumptions),
        }),
      );
    } catch (error) {
      setError(error);
    } finally {
      setBusy(null);
    }
  };

  const setError = (error: unknown) =>
    setProblem(error instanceof Error ? error.message : String(error));

  const close = () => {
    // Closing with a prepared package discards it; the caller's owner is still
    // the source, so this is safe and explicit.
    if (handoff?.state === 'prepared') void onCancelHandoff(handoff).catch(() => {});
    onClose();
  };

  const canPrepare =
    goal.trim().length > 0 &&
    nextAction.trim().length > 0 &&
    toHarnessId !== conversation.harnessId;

  return (
    <Drawer width={480} visible={visible} title="交接任务" footer={null} onCancel={close}>
      {handoff?.state === 'prepared' && handoff.package ? (
        <PackageReview
          handoff={handoff}
          pkg={handoff.package}
          busy={busy}
          onBack={() => {
            if (busy) return;
            // Going back discards the frozen package: core still holds the
            // conversation, and leaving it held would block every prompt.
            void onCancelHandoff(handoff).catch(setError);
            setHandoff(null);
          }}
          onCommit={async () => {
            setBusy('commit');
            try {
              await onCommit(handoff);
            } catch (error) {
              setError(error);
              setBusy(null);
            }
          }}
        />
      ) : (
        <Form layout="vertical" size="small" className="text-[13px]">
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-tint-1 px-3 py-2.5">
            <AgentAvatar agent={conversation.harnessId} size="sm" />
            <span className="font-medium">{PERSONAS[conversation.harnessId].name}</span>
            <span className="text-fg-3">→</span>
            {candidates.length > 0 ? (
              <Select
                size="small"
                className="w-40"
                value={toHarnessId}
                onChange={(value) => setToHarnessId(value as HarnessId)}
                options={candidates.map((h) => ({ label: PERSONAS[h.id].name, value: h.id }))}
              />
            ) : (
              <span className="text-warn">没有可用的其他 Agent</span>
            )}
            <span className="ml-auto text-xs text-fg-3">精简交接 · 同一工作目录</span>
          </div>

          <Form.Item label="任务目前进行到哪一步（目标）" required>
            <Input
              value={goal}
              onChange={setGoal}
              maxLength={500}
              placeholder="例如：修复登录后的异常跳转"
              aria-label="交接目标"
            />
          </Form.Item>
          <Form.Item label="接手方先做什么" required>
            <Input.TextArea
              value={nextAction}
              onChange={setNextAction}
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={1000}
              placeholder="例如：先运行已记录的复现步骤，确认现象后再改代码"
              aria-label="接手方先做什么"
            />
          </Form.Item>
          <Form.Item label="已确认的事实（每行一条）">
            <Input.TextArea
              value={facts}
              onChange={setFacts}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="你或原 Agent 已经验证过的结论"
              aria-label="已确认的事实"
            />
          </Form.Item>
          <Form.Item label="尚未验证的假设（每行一条）">
            <Input.TextArea
              value={assumptions}
              onChange={setAssumptions}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="猜测，会被单独标注，不会被当成事实"
              aria-label="尚未验证的假设"
            />
          </Form.Item>

          <Alert
            type="warning"
            content={`准备交接会先停止 ${PERSONAS[conversation.harnessId].name} 并确认进程已退出；无法确认时交接会被阻止。此后新消息会排队，直到交接完成。`}
          />
          {problem && (
            <Alert
              className="mt-3"
              type="error"
              content={problem}
              closable
              onClose={() => setProblem(null)}
            />
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={close}>取消</Button>
            <Button
              type="primary"
              disabled={!canPrepare || busy !== null}
              loading={busy === 'prepare'}
              onClick={() => void prepare()}
            >
              停止原 Agent 并准备交接
            </Button>
          </div>
        </Form>
      )}
    </Drawer>
  );
}

/** The frozen package, shown exactly as it will be sent. */
function PackageReview({
  handoff,
  pkg,
  busy,
  onBack,
  onCommit,
}: {
  handoff: Handoff;
  pkg: HandoffPackage;
  busy: 'prepare' | 'commit' | 'cancel' | null;
  onBack: () => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="flex items-center gap-2 rounded-lg bg-tint-1 px-3 py-2.5">
        <AgentAvatar agent={pkg.fromHarnessId} size="sm" />
        <span className="font-medium">{PERSONAS[pkg.fromHarnessId].name}</span>
        <span className="text-fg-3">→</span>
        <AgentAvatar agent={pkg.toHarnessId} size="sm" />
        <span className="font-medium">{PERSONAS[pkg.toHarnessId].name}</span>
        <Tag className="ml-auto" size="small">
          约 {pkg.estimatedTokens} tokens · 估算
        </Tag>
      </div>

      <Section title="任务目标">
        <p className="m-0 text-xs text-fg-1">{pkg.goal}</p>
      </Section>
      <Section title="下一步">
        <p className="m-0 text-xs text-fg-1">{pkg.nextAction}</p>
      </Section>
      <Section title="必带要求" note="来自你的原话，不会被摘要改写">
        {pkg.userRequirements.length === 0 ? (
          <p className="m-0 text-xs text-fg-3">（这个会话还没有用户消息）</p>
        ) : (
          pkg.userRequirements.map((r) => (
            <Row key={r.sourceMessageId} icon="kept" note={`消息 ${r.sourceMessageId.slice(0, 6)}`}>
              {r.text}
            </Row>
          ))
        )}
      </Section>
      {pkg.confirmedFacts.length > 0 && (
        <Section title="已确认的事实">
          {pkg.confirmedFacts.map((fact) => (
            <Row key={fact} icon="kept">
              {fact}
            </Row>
          ))}
        </Section>
      )}
      {pkg.assumptions.length > 0 && (
        <Section title="未验证的假设">
          {pkg.assumptions.map((a) => (
            <Row key={a} icon="hypothesis">
              {a}
            </Row>
          ))}
        </Section>
      )}
      <Section title="文件与工作区">
        <Row icon="kept" note="基准提交">
          {pkg.workspace.baseCommit?.slice(0, 10) ?? '未知'}
        </Row>
        <Row icon="kept" note="未提交改动">
          {pkg.workspace.dirtyDiff ? `${pkg.workspace.dirtyDiff.length} 字符的 diff 已记录` : '无'}
        </Row>
        <Row icon="kept" note="未跟踪">
          {pkg.workspace.untrackedFiles.length > 0 ? pkg.workspace.untrackedFiles.join('、') : '无'}
        </Row>
      </Section>
      {pkg.omitted.length > 0 && (
        <Section title="省略的内容" note="接收方可以按需读取原会话">
          {pkg.omitted.map((o) => (
            <Row key={o.item} icon="omitted" note={o.reason}>
              {o.item}
            </Row>
          ))}
        </Section>
      )}

      <div className="rounded-lg border border-warn bg-warn-soft px-3 py-2 text-xs text-fg-1">
        确认后负责人切换为 {PERSONAS[pkg.toHarnessId].name}
        ，它会在同一个工作目录继续；交接期间排队的消息会交给它。
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onBack} disabled={busy !== null}>
          返回修改
        </Button>
        <Button
          type="primary"
          loading={busy === 'commit'}
          disabled={busy !== null}
          onClick={onCommit}
        >
          确认交接
        </Button>
      </div>
      <span className="sr-only">交接编号 {handoff.id}</span>
    </div>
  );
}

function Section({
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

function Row({
  icon,
  note,
  children,
}: {
  icon: 'kept' | 'hypothesis' | 'omitted';
  note?: string;
  children: React.ReactNode;
}) {
  const marker =
    icon === 'kept' ? (
      <IconCheckCircle className="mt-0.5 shrink-0 text-ok" />
    ) : icon === 'hypothesis' ? (
      <IconExclamationCircle className="mt-0.5 shrink-0 text-warn" />
    ) : (
      <IconMinusCircle className="mt-0.5 shrink-0 text-fg-3" />
    );
  return (
    <li className="flex items-start gap-2 text-xs">
      {marker}
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-fg-1">{children}</span>
      {note && <span className="shrink-0 text-[10px] text-fg-4">{note}</span>}
    </li>
  );
}
