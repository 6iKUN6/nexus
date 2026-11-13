import { randomUUID } from 'node:crypto';
import {
  type CollaborationTool,
  type Conversation,
  type HarnessId,
  RpcError,
  type Task,
} from '@nexus/protocol';
import type { ConversationService } from '../conversations/conversationService';
import { harnessLabel } from '../harness/catalog';
import type { MessageService } from '../messaging/messageService';
import type { TaskService } from '../tasks/taskService';
import type { CollabHandler } from './server';

/**
 * The five collaboration tools agents can call (D14, ADR 0016). Everything an
 * agent may do arrives here with an already-authenticated conversation id; the
 * checks below are about the task relationship, not about who is on the wire.
 *
 * Values returned to an agent are data. They never become instructions: core
 * records them as events and the user decides what happens next.
 */

export type CollaborationServiceDeps = {
  conversations: ConversationService;
  tasks: TaskService;
  messages: MessageService;
  /** Whether an adapter is currently available for a harness id. */
  isHarnessSupported: (harnessId: HarnessId) => boolean;
  newId?: () => string;
};

export const CollaborationErrorCode = {
  NotASubtask: 4020,
  SelfHandoff: 4021,
  HarnessUnsupported: 4022,
} as const;

export class CollaborationService {
  private readonly newId: () => string;

  constructor(private readonly deps: CollaborationServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  readonly handlers: Record<CollaborationTool, CollabHandler> = {
    read_task_context: async (conversationId) => {
      const conversation = this.deps.conversations.get(conversationId);
      return this.context(conversation);
    },

    send_message: async (conversationId, params) => {
      const input = params as { text: string; reply_to?: string | undefined };
      const task = this.requireParentTask(conversationId);
      const message = this.deps.messages.send({
        senderId: conversationId,
        recipientId: task.parentConversationId,
        taskId: task.id,
        text: input.text,
        replyTo: input.reply_to ?? null,
      });
      return { messageId: message.id, state: message.state };
    },

    delegate: async (conversationId, params) => {
      const input = params as {
        goal: string;
        acceptance?: string | undefined;
        harness?: HarnessId | undefined;
      };
      const conversation = this.deps.conversations.get(conversationId);
      const harnessId = input.harness ?? conversation.harnessId;
      const { task, childConversation } = await this.deps.tasks.delegate({
        conversationId,
        goal: input.goal,
        acceptance: input.acceptance ?? null,
        harnessId,
      });
      return { taskId: task.id, conversationId: childConversation.id };
    },

    report_result: async (conversationId, params) => {
      const input = params as { summary: string; blocked: boolean };
      const result = this.deps.tasks.reportResult({
        conversationId,
        summary: input.summary,
        blocked: input.blocked,
      });
      return result;
    },

    request_handoff: async (conversationId, params) => {
      const input = params as { toHarnessId: HarnessId; reason: string };
      const conversation = this.deps.conversations.get(conversationId);
      if (input.toHarnessId === conversation.harnessId) {
        throw new RpcError(CollaborationErrorCode.SelfHandoff, '这个会话已经在该 harness 上运行');
      }
      if (!this.deps.isHarnessSupported(input.toHarnessId)) {
        throw new RpcError(
          CollaborationErrorCode.HarnessUnsupported,
          `暂不支持交接到 ${harnessLabel(input.toHarnessId)}`,
        );
      }
      // Only recorded: the user still confirms the handoff dialog (ADR 0011).
      this.deps.conversations.recordCollaborationEvent(conversationId, {
        type: 'handoff.requested',
        toHarnessId: input.toHarnessId,
        reason: input.reason,
      });
      return { recorded: true as const };
    },
  };

  private context(conversation: Conversation) {
    const { children, parent } = this.deps.tasks.list(conversation.id);
    if (parent) {
      return {
        role: 'child' as const,
        taskId: parent.id,
        goal: parent.goal,
        acceptance: parent.acceptance,
        status: parent.status,
      };
    }
    return {
      role: children.length > 0 ? ('parent' as const) : ('standalone' as const),
      taskId: null,
      goal: conversation.goal,
      acceptance: null,
      status: null,
    };
  }

  private requireParentTask(conversationId: string): Task {
    const task = this.deps.tasks.list(conversationId).parent;
    if (!task) {
      throw new RpcError(
        CollaborationErrorCode.NotASubtask,
        '只有子任务能向委派方发消息；当前会话没有上级任务',
      );
    }
    return task;
  }
}
