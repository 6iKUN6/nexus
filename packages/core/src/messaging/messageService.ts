import { randomUUID } from 'node:crypto';
import { type ConversationEvent, type MessageRecord, RpcError } from '@nexus/protocol';
import type { ConversationService } from '../conversations/conversationService';
import type { Store } from '../store/store';

/**
 * Delivery semantics for agent-to-agent messages (D15, ADR 0017).
 *
 * Write first, then dispatch: a row in `messages` is the outbox AND the
 * inbox, and the message id is the dedupe point. Delivery itself means the
 * text is queued as a `core-`-prefixed prompt in the recipient conversation;
 * `consumed` only once the run carrying it has actually started — the
 * strongest signal available without claiming the model "read" anything.
 *
 * Nothing is re-sent automatically: a restart or a failed run moves the
 * message to `needs_check`, and only the user resends it (same id, idempotent).
 */

export const MessageErrorCode = {
  NotFound: 4004,
  InvalidState: 4030,
  InvalidReplyTarget: 4031,
} as const;

export type MessageServiceDeps = {
  store: Store;
  conversations: ConversationService;
  now?: () => number;
  newId?: () => string;
};

const GOAL_LABEL_MAX = 30;

export class MessageService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: MessageServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  list(conversationId: string): MessageRecord[] {
    return this.deps.store.listMessagesFor(conversationId);
  }

  /**
   * Records and delivers a message. The caller validates the relationship;
   * this service owns persistence, the delivery prompt and state transitions.
   * Returns the row, so a duplicate id reports the original's state.
   */
  send(input: {
    senderId: string;
    recipientId: string;
    taskId: string | null;
    text: string;
    replyTo: string | null;
  }): MessageRecord {
    if (input.replyTo) {
      const target = this.deps.store.getMessage(input.replyTo);
      const involves =
        target !== null &&
        (target.senderId === input.senderId || target.recipientId === input.senderId);
      if (!involves) {
        throw new RpcError(MessageErrorCode.InvalidReplyTarget, 'reply_to 指向的消息不存在');
      }
    }
    const id = this.newId();
    const inserted = this.deps.store.insertMessage({
      id,
      senderId: input.senderId,
      recipientId: input.recipientId,
      taskId: input.taskId,
      kind: 'message',
      text: input.text,
      replyTo: input.replyTo,
      state: 'queued',
      runId: null,
      createdAt: this.now(),
      deliveredAt: null,
      consumedAt: null,
    });
    if (!inserted.created) return inserted.message; // dedupe: never deliver twice
    const message = inserted.message;

    this.deps.conversations.recordCollaborationEvent(message.senderId, {
      type: 'agent.message',
      messageId: message.id,
      peerConversationId: message.recipientId,
      direction: 'out',
      text: message.text,
    });
    this.deps.conversations.recordCollaborationEvent(message.recipientId, {
      type: 'agent.message',
      messageId: message.id,
      peerConversationId: message.senderId,
      direction: 'in',
      text: message.text,
    });
    if (input.replyTo) {
      this.deps.store.updateMessage(input.replyTo, { state: 'replied' });
    }
    return this.deliver(message);
  }

  /** User-initiated redelivery of a message stuck in `needs_check` (or failed). */
  resend(messageId: string): MessageRecord {
    const message = this.deps.store.getMessage(messageId);
    if (!message) {
      throw new RpcError(MessageErrorCode.NotFound, '消息不存在');
    }
    if (message.state !== 'needs_check' && message.state !== 'failed') {
      throw new RpcError(MessageErrorCode.InvalidState, '只有需核对或失败的消息可以重发');
    }
    const reset = this.deps.store.updateMessage(messageId, {
      state: 'queued',
      runId: null,
      deliveredAt: null,
      consumedAt: null,
    });
    return this.deliver(reset);
  }

  /**
   * Boot-time reconciliation: anything that never reached `consumed` has an
   * unknown outcome (the recipient process died with core), so it is marked
   * for review instead of being resent silently.
   */
  reconcile(): void {
    for (const message of this.deps.store.listInflightMessages()) {
      this.deps.store.updateMessage(message.id, { state: 'needs_check' });
    }
  }

  /** Watches run lifecycle events to advance delivered → consumed/needs_check. */
  observeEvent(event: ConversationEvent): void {
    const body = event.body;
    if (body.type === 'run.started') {
      const message = this.deps.store.getMessageByRun(body.runId);
      if (message?.state === 'delivered') {
        this.deps.store.updateMessage(message.id, {
          state: 'consumed',
          consumedAt: this.now(),
        });
      }
      return;
    }
    const failed =
      body.type === 'run.failed' ||
      (body.type === 'run.completed' && body.stopReason === 'cancelled');
    if (!failed) return;
    const message = this.deps.store.getMessageByRun(body.runId);
    // The prompt may or may not have reached the model: uncertain, so review.
    if (message?.state === 'delivered') {
      this.deps.store.updateMessage(message.id, { state: 'needs_check' });
    }
  }

  private deliver(message: MessageRecord): MessageRecord {
    const task = message.taskId ? this.deps.store.getTask(message.taskId) : null;
    const sender = task
      ? `子任务「${task.goal.replace(/\s+/g, ' ').slice(0, GOAL_LABEL_MAX)}」`
      : `会话「${this.deps.conversations.get(message.senderId).title}」`;
    const prompt = [
      `core-[协作消息，来自${sender}，id=${message.id}]`,
      message.text,
      `（如需回复，调用 send_message 并带 reply_to="${message.id}"）`,
    ].join('\n');
    try {
      const { runId } = this.deps.conversations.send(message.recipientId, prompt);
      return this.deps.store.updateMessage(message.id, {
        state: 'delivered',
        runId,
        deliveredAt: this.now(),
      });
    } catch {
      return this.deps.store.updateMessage(message.id, { state: 'failed' });
    }
  }
}
