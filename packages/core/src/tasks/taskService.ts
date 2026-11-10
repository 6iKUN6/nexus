import type { Conversation, HarnessId, Task } from '@nexus/protocol';
import { RpcError } from '@nexus/protocol';
import type { ConversationService } from '../conversations/conversationService';
import type { Store } from '../store/store';

/**
 * Delegation (M3, ADR 0008): user-initiated sub-tasks. A delegation creates a
 * worktree-isolated child conversation and a task row; this service watches
 * the child's state and mirrors every transition as a `task.*` event on the
 * parent's log, so the parent timeline renders live progress cards and the
 * inbox can surface results awaiting review.
 *
 * Scope limits of the first version: one delegation level only (a child may
 * not delegate further), and results return automatically when the child
 * finishes — agent-initiated collaboration (the MCP/helper channel, D14) is
 * deliberately deferred, as the plan's deferral list allows.
 */

export const TaskErrorCode = {
  DelegationDepth: 4011,
  InvalidTaskState: 4012,
  NotFound: 4004,
} as const;

type TaskServiceDeps = {
  store: Store;
  conversations: ConversationService;
  now: () => number;
  newId: () => string;
};

const SUMMARY_MAX = 1500;

function composeBrief(task: Task, parent: Conversation, child: Conversation): string {
  const base = parent.baseCwd ?? parent.cwd;
  return [
    '你是 Nexus 中的一个子任务执行者。另一个会话把下面这项子任务委派给你，请独立完成。',
    '',
    '## 子任务目标',
    task.goal,
    '',
    '## 验收标准',
    task.acceptance ?? '（委派方未提供；以目标为准）',
    '',
    '## 工作区',
    `你在 ${child.cwd} 工作，这是 ${base} 的独立 worktree，与委派方互不影响。`,
    '',
    '完成后请给出简要结果说明：做了什么、如何验证、还有哪些遗留。',
  ].join('\n');
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  list(conversationId: string): { children: Task[]; parent: Task | null } {
    return {
      children: this.deps.store.listTasksByParent(conversationId),
      parent: this.deps.store.getTaskByChild(conversationId),
    };
  }

  inbox(): Array<{ conversationId: string; status: Task['status'] }> {
    return this.deps.store.listTaskInbox();
  }

  async delegate(input: {
    conversationId: string;
    goal: string;
    acceptance: string | null;
    harnessId: HarnessId;
  }): Promise<{ task: Task; childConversation: Conversation }> {
    const parent = this.deps.conversations.get(input.conversationId);
    if (this.deps.store.getTaskByChild(parent.id)) {
      throw new RpcError(TaskErrorCode.DelegationDepth, '子任务不能再次委派（当前只支持一层）');
    }
    // The child branches from the same base as the parent, always isolated:
    // delegated work runs in parallel and must never share a directory.
    const child = await this.deps.conversations.create({
      harnessId: input.harnessId,
      cwd: parent.baseCwd ?? parent.cwd,
      isolation: 'worktree',
      title: input.goal.replace(/\s+/g, ' ').slice(0, 30),
    });
    const now = this.deps.now();
    const task: Task = {
      id: this.deps.newId(),
      parentConversationId: parent.id,
      childConversationId: child.id,
      goal: input.goal,
      acceptance: input.acceptance,
      harnessId: input.harnessId,
      status: 'running',
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertTask(task);
    this.deps.conversations.recordTaskEvent(parent.id, {
      type: 'task.delegated',
      taskId: task.id,
      childConversationId: child.id,
      goal: task.goal,
      acceptance: task.acceptance,
      harnessId: task.harnessId,
    });
    this.deps.conversations.send(child.id, composeBrief(task, parent, child));
    return { task, childConversation: child };
  }

  respond(input: { taskId: string; action: 'accept' | 'request_changes'; feedback: string }): {
    task: Task;
  } {
    const task = this.deps.store.getTask(input.taskId);
    if (!task) throw new RpcError(TaskErrorCode.NotFound, `子任务不存在：${input.taskId}`);
    if (input.action === 'accept') {
      if (task.status !== 'review') {
        throw new RpcError(TaskErrorCode.InvalidTaskState, '只有待验收的子任务能通过验收');
      }
      const updated = this.deps.store.updateTaskStatus(
        task.id,
        'accepted',
        task.resultSummary,
        this.deps.now(),
      );
      this.deps.conversations.recordTaskEvent(task.parentConversationId, {
        type: 'task.updated',
        taskId: task.id,
        status: 'accepted',
        summary: null,
      });
      return { task: updated };
    }
    if (task.status !== 'review' && task.status !== 'failed') {
      throw new RpcError(TaskErrorCode.InvalidTaskState, '子任务还在进行中，不能退回');
    }
    const feedback = input.feedback.trim() || '结果未通过验收，请继续完善。';
    const updated = this.deps.store.updateTaskStatus(task.id, 'running', null, this.deps.now());
    this.deps.conversations.recordTaskEvent(task.parentConversationId, {
      type: 'task.updated',
      taskId: task.id,
      status: 'running',
      summary: feedback,
    });
    this.deps.conversations.send(
      task.childConversationId,
      `委派方反馈（验收未通过）：\n${feedback}\n\n请根据反馈继续，完成后再次总结结果。`,
    );
    return { task: updated };
  }

  /**
   * Watches child conversations. Transitions fire only while the task is
   * `running` and the child has finished at least one run, so the idle state
   * right after creation (before the first run starts) is not mistaken for
   * completion.
   */
  observeConversation(conversation: Conversation): void {
    const task = this.deps.store.getTaskByChild(conversation.id);
    if (!task || task.status !== 'running') return;
    if (conversation.state === 'failed') {
      this.finish(task, 'failed', conversation.preview || null);
      return;
    }
    if (conversation.state === 'idle' && this.hasFinishedRun(conversation.id)) {
      this.finish(task, 'review', this.lastRunSummary(conversation.id));
    }
  }

  /**
   * Boot-time reconciliation for tasks whose transition was lost to a crash
   * (the child settled while core was down). Never re-runs anything.
   */
  reconcile(): void {
    for (const conversation of this.deps.conversations.list()) {
      this.observeConversation(conversation);
    }
  }

  private finish(task: Task, status: 'review' | 'failed', summary: string | null): void {
    this.deps.store.updateTaskStatus(task.id, status, summary, this.deps.now());
    this.deps.conversations.recordTaskEvent(task.parentConversationId, {
      type: 'task.updated',
      taskId: task.id,
      status,
      summary,
    });
  }

  private hasFinishedRun(conversationId: string): boolean {
    return this.deps.store
      .listEvents(conversationId, 0)
      .some((e) => e.body.type === 'run.completed' || e.body.type === 'run.failed');
  }

  /** The child run's streamed text, from its last run.started onwards. */
  private lastRunSummary(conversationId: string): string {
    const events = this.deps.store.listEvents(conversationId, 0);
    const startIndex = events.findLastIndex((e) => e.body.type === 'run.started');
    const text = events
      .slice(startIndex < 0 ? 0 : startIndex)
      .flatMap((e) => (e.body.type === 'text.delta' ? [e.body.text] : []))
      .join('')
      .trim();
    if (!text) return '（子任务没有文字产出）';
    return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
  }
}
