import type { Conversation, ConversationEvent, HarnessId } from '@nexus/protocol';

/**
 * Prefills the handoff dialog (D22) from data already in the log — no model
 * call. The goal chain is explicit goal → first user message → title; the
 * next action summarises the last failure (when there was one) plus the most
 * recent requirement. Everything stays editable in the dialog: these are
 * defaults for a human to review, never decisions.
 */

const GOAL_MAX = 500;
const NEXT_ACTION_MAX = 1000;
const LAST_USER_CHARS = 200;
const FAILURE_CHARS = 200;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export type HandoffSuggestion = {
  goal: string;
  nextAction: string;
  /** Fallback harness when it is usable and not the current owner; else null. */
  toHarnessId: HarnessId | null;
};

export function suggestHandoff(
  conversation: Conversation,
  events: readonly ConversationEvent[],
  isSupported: (id: HarnessId) => boolean,
): HandoffSuggestion {
  const requirements: string[] = [];
  let failure: string | null = null;
  for (const event of events) {
    if (event.body.type === 'user.message') {
      // Prompts core itself sent are not the user's words (same rule as the
      // context package): quoting them as the goal would mislead the receiver.
      if (!event.body.messageId.startsWith('core-')) requirements.push(event.body.text);
    } else if (event.body.type === 'run.failed') {
      failure = event.body.error.message;
    }
  }
  const first = requirements[0];
  const last = requirements.at(-1);

  const explicit = conversation.goal?.trim();
  const goal = clip(explicit || first?.trim() || conversation.title, GOAL_MAX);

  const parts: string[] = [];
  if (failure) {
    parts.push(`从上次失败处继续（失败原因：${clip(failure, FAILURE_CHARS)}）`);
  } else {
    parts.push('继续当前任务');
  }
  if (last) parts.push(`最近的用户要求：${clip(last.trim(), LAST_USER_CHARS)}`);
  parts.push('先核对工作目录中的实际改动，再继续推进');
  const nextAction = clip(`${parts.join('。')}。`, NEXT_ACTION_MAX);

  const fallback = conversation.fallbackHarnessId;
  const toHarnessId =
    fallback && fallback !== conversation.harnessId && isSupported(fallback) ? fallback : null;

  return { goal, nextAction, toHarnessId };
}
