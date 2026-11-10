import type { Conversation, ConversationEvent, HandoffPackage } from '@nexus/protocol';

/**
 * Assembles the context package for a handoff (plan §8, ADR 0011).
 *
 * Order matters: the user's own words and the acceptance criteria come first,
 * then the working state and the next action, then the materials that look
 * relevant. Everything is derived from the event log — a summary that cannot
 * be traced to a message is not included. The one piece of judgment the
 * assembler does make (which agent prose to keep) is labelled as such.
 */

/** A source event is quoted by id so the receiver can ask for the original. */
type Requirement = HandoffPackage['userRequirements'][number];

const RECENT_TEXT_CHARS = 1200;
const MAX_REQUIREMENTS = 12;
const MAX_UNTRACKED_LISTED = 40;

export type AssembleInput = {
  conversation: Conversation;
  events: readonly ConversationEvent[];
  toHarnessId: Conversation['harnessId'];
  goal: string;
  nextAction: string;
  facts: string[];
  assumptions: string[];
  workspace: HandoffPackage['workspace'];
  diffTruncated: boolean;
  secretFiles: string[];
};

export function assemblePackage(input: AssembleInput): HandoffPackage {
  const { conversation, events } = input;
  const requirements: Requirement[] = [];
  const omitted: HandoffPackage['omitted'] = [];

  // Every user message is a requirement: corrections are user messages too,
  // and a receiver that loses one repeats the mistake.
  for (const { body } of events) {
    if (body.type !== 'user.message') continue;
    // Prompts core itself sent (delegation and handoff briefs) are not the
    // user's words; quoted as requirements they would mislead the receiver.
    if (body.messageId.startsWith('core-')) continue;
    requirements.push({ text: body.text, sourceMessageId: body.messageId });
  }
  const recent = requirements.slice(-MAX_REQUIREMENTS);
  if (recent.length < requirements.length) {
    omitted.push({
      item: `更早的 ${requirements.length - recent.length} 条用户消息`,
      reason: '保留最近的纠正与要求；更早的消息可按需从原会话读取',
    });
  }

  // The last agent turn is what the previous owner claims it did. It is kept
  // apart from user-stated facts because it is a claim, not a verified fact.
  const lastRunText = closingText(events);
  const confirmedFacts = lastRunText
    ? [`原 Agent 最后汇报：${lastRunText}`, ...input.facts]
    : input.facts;

  const untracked = input.workspace.untrackedFiles;
  const listed = untracked.slice(0, MAX_UNTRACKED_LISTED);
  if (listed.length < untracked.length) {
    omitted.push({
      item: `另 ${untracked.length - listed.length} 个未跟踪文件`,
      reason: `清单只列前 ${MAX_UNTRACKED_LISTED} 个，避免交接包过长`,
    });
  }
  if (input.diffTruncated) {
    omitted.push({
      item: '未提交 diff 的后半部分',
      reason: 'diff 过长已截断；文件本身就在同一个工作目录里，可直接读取',
    });
  }
  if (input.secretFiles.length > 0) {
    omitted.push({
      item: `疑似密钥文件：${input.secretFiles.join('、')}`,
      reason: '可能含密钥，默认不写入交接包',
    });
  }

  const pkg: HandoffPackage = {
    schemaVersion: 1,
    conversationId: conversation.id,
    fromHarnessId: conversation.harnessId,
    toHarnessId: input.toHarnessId,
    ownerVersion: conversation.ownerVersion,
    goal: input.goal,
    nextAction: input.nextAction,
    userRequirements: recent,
    confirmedFacts,
    assumptions: input.assumptions,
    workspace: { ...input.workspace, untrackedFiles: listed },
    omitted,
    // No exact tokenizer is available; ~2.5 chars per token is a rough
    // CJK+code average and the UI labels the number as an estimate.
    estimatedTokens: 0,
  };
  return { ...pkg, estimatedTokens: Math.ceil(composeBrief(pkg).length / 2.5) };
}

/**
 * The brief the receiving agent actually sees. It is deliberately explicit
 * that quoted output came from another agent, so the receiver does not treat
 * it as instructions (plan §7: tool results are data, not user commands).
 */
export function composeBrief(pkg: HandoffPackage): string {
  const sections = [
    '你是 Nexus 中的接手方。上一任 Agent 已停止，这个任务现在由你负责。',
    '',
    '## 任务目标',
    pkg.goal,
    '',
    '## 用户要求（原文，不得改写）',
    ...pkg.userRequirements.map((r) => `- ${r.text}`),
    '',
    '## 下一步',
    pkg.nextAction,
  ];
  if (pkg.confirmedFacts.length > 0) {
    sections.push('', '## 已确认的事实', ...pkg.confirmedFacts.map((f) => `- ${f}`));
  }
  if (pkg.assumptions.length > 0) {
    sections.push('', '## 尚未验证的假设（不要当作事实）', ...pkg.assumptions.map((a) => `- ${a}`));
  }
  sections.push(
    '',
    '## 工作区',
    `你在 ${pkg.workspace.root} 继续，这是上一任使用的工作目录，未提交的改动都还在。`,
    pkg.workspace.baseCommit ? `基准提交：${pkg.workspace.baseCommit}` : '基准提交：未知',
    pkg.workspace.untrackedFiles.length > 0
      ? `未跟踪文件：${pkg.workspace.untrackedFiles.join('、')}`
      : '未跟踪文件：无',
  );
  if (pkg.omitted.length > 0) {
    sections.push(
      '',
      '## 未随包提供的内容（可按需读取原会话）',
      ...pkg.omitted.map((o) => `- ${o.item}：${o.reason}`),
    );
  }
  sections.push(
    '',
    '衔接时请先确认工作目录的当前状态，需要修改前先说明计划。完成后给出简要结果：做了什么、如何验证、还有哪些遗留。',
  );
  return sections.join('\n');
}

/** Text of the final assistant turn of the most recent started run. */
function closingText(events: readonly ConversationEvent[]): string | null {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.body.type === 'run.started') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const text = events
    .slice(start)
    .flatMap((e) => (e.body.type === 'text.delta' ? [e.body.text] : []))
    .join('')
    .trim();
  if (!text) return null;
  return text.length > RECENT_TEXT_CHARS ? text.slice(-RECENT_TEXT_CHARS) : text;
}
