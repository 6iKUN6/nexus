import {
  type AgentAdapter,
  type Conversation,
  type Handoff,
  type HarnessId,
  RpcError,
} from '@nexus/protocol';
import type { ConversationService } from '../conversations/conversationService';
import type { Store } from '../store/store';
import { VersionConflict } from '../store/store';
import { captureWorkspace, type GitRun } from '../worktree/gitWorktree';
import { assemblePackage, composeBrief } from './contextPackage';

/**
 * Simplifed handoff (M4, ADR 0011): `stopping_source → prepared → committed →
 * running`, with `aborted` / `needs_reconciliation` as failure states.
 *
 * The physical isolation comes from two things, not from the state machine:
 * the source process is verified gone (`StopResult.confirmed`) and the
 * receiver works in the same directory as the only writer. The state machine
 * only guarantees that ownership changes atomically and is never ambiguous
 * after a crash.
 */

export const HandoffErrorCode = {
  NotFound: 4004,
  NotSupported: 4005,
  InvalidState: 4014,
  VersionConflict: 4015,
} as const;

type HandoffServiceDeps = {
  store: Store;
  conversations: ConversationService;
  adapters: Partial<Record<HarnessId, AgentAdapter>>;
  gitRun: GitRun;
  now: () => number;
  newId: () => string;
};

export class HandoffService {
  /**
   * Conversation updates are ignored until boot reconciliation has run: a
   * recovered `run.failed(interrupted)` would otherwise be read as a receiver
   * failure and finalise the handoff before the handoff itself is checked.
   */
  private booted = false;

  constructor(private readonly deps: HandoffServiceDeps) {}

  /**
   * Stops the source agent (and blocks when that cannot be verified), then
   * freezes the package for review. Nothing changes owner here.
   */
  async prepare(input: {
    conversationId: string;
    toHarnessId: HarnessId;
    goal: string;
    nextAction: string;
    facts: string[];
    assumptions: string[];
  }): Promise<Handoff> {
    const conversation = this.deps.conversations.get(input.conversationId);
    if (input.toHarnessId === conversation.harnessId) {
      throw new RpcError(HandoffErrorCode.InvalidState, '接收方必须与当前负责人不同');
    }
    if (!this.deps.adapters[input.toHarnessId]) {
      throw new RpcError(
        HandoffErrorCode.NotSupported,
        `暂不支持把任务交接给 ${input.toHarnessId}`,
      );
    }
    if (this.preparedFor(conversation.id)) {
      throw new RpcError(HandoffErrorCode.InvalidState, '这个会话已有一个待确认的交接');
    }

    const now = this.deps.now();
    const handoff: Handoff = {
      id: this.deps.newId(),
      conversationId: conversation.id,
      state: 'stopping_source',
      fromHarnessId: conversation.harnessId,
      toHarnessId: input.toHarnessId,
      package: null,
      problem: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertHandoff(handoff);

    // Hold first: from here on a prompt queues instead of restarting the old
    // owner behind the user's back.
    this.deps.conversations.hold(conversation.id);
    try {
      const stopped = await this.deps.conversations.stopSession(conversation.id);
      if (!stopped.confirmed) {
        const problem = `无法确认原 Agent 已停止，交接已阻止。${stopped.problem ?? ''}`.trim();
        throw new RpcError(HandoffErrorCode.InvalidState, problem);
      }

      const captured = await captureWorkspace(this.deps.gitRun, conversation.cwd);
      const pkg = assemblePackage({
        conversation: this.currentConversation(conversation.id),
        events: this.deps.conversations.events(conversation.id, 0),
        toHarnessId: input.toHarnessId,
        goal: input.goal,
        nextAction: input.nextAction,
        facts: input.facts,
        assumptions: input.assumptions,
        workspace: captured.workspace,
        diffTruncated: captured.truncatedDiff,
        secretFiles: captured.secretFiles,
      });
      return this.deps.store.updateHandoff(
        handoff.id,
        { state: 'prepared', package: pkg },
        handoff.version,
        this.deps.now(),
      );
    } catch (error) {
      // Nothing was frozen and the owner did not move: release the hold, or
      // the conversation would reject prompts until the app restarts.
      this.deps.conversations.releaseHold(conversation.id);
      const problem = error instanceof Error ? error.message : String(error);
      this.abort(handoff, conversation, problem);
      throw error instanceof RpcError
        ? error
        : new RpcError(HandoffErrorCode.InvalidState, problem);
    }
  }

  /**
   * Swaps the owner (CAS on the reviewed version), then starts the receiver.
   * A failure after the transaction keeps the new owner and reports the
   * handoff as `needs_reconciliation`, never silently rolls back.
   */
  async commit(input: { handoffId: string; version: number }): Promise<{
    handoff: Handoff;
    conversation: Conversation;
  }> {
    const handoff = this.require(input.handoffId);
    const frozen = handoff.package;
    if (handoff.state !== 'prepared' || !frozen) {
      throw new RpcError(HandoffErrorCode.InvalidState, '这个交接不在待确认状态');
    }
    let result: { handoff: Handoff; conversation: Conversation };
    try {
      result = this.deps.store.commitHandoff({
        handoffId: handoff.id,
        expectedHandoffVersion: input.version,
        preview: '已交接，等待接手方开始',
        now: this.deps.now(),
      });
    } catch (error) {
      if (error instanceof VersionConflict) {
        throw new RpcError(HandoffErrorCode.VersionConflict, error.message);
      }
      throw error;
    }
    this.deps.conversations.recordHandoffEvent(result.conversation.id, {
      type: 'handoff',
      handoffId: handoff.id,
      fromHarnessId: handoff.fromHarnessId,
      toHarnessId: handoff.toHarnessId,
      goal: frozen.goal,
      state: 'committed',
      problem: null,
    });
    try {
      // The brief goes to the front: prompts typed during the review run after
      // it, under the new owner (plan §7 routes them on commit).
      this.deps.conversations.send(result.conversation.id, composeBrief(frozen), { front: true });
      this.deps.conversations.releaseHold(result.conversation.id);
    } catch (error) {
      const problem = `交接已生效，但接手方未能启动：${
        error instanceof Error ? error.message : String(error)
      }`;
      this.deps.conversations.releaseHold(result.conversation.id);
      const failed = this.deps.store.updateHandoff(
        result.handoff.id,
        { state: 'needs_reconciliation', problem },
        result.handoff.version,
        this.deps.now(),
      );
      this.deps.conversations.recordHandoffEvent(result.conversation.id, {
        type: 'handoff',
        handoffId: handoff.id,
        fromHarnessId: handoff.fromHarnessId,
        toHarnessId: handoff.toHarnessId,
        goal: frozen.goal,
        state: 'needs_reconciliation',
        problem,
      });
      throw new RpcError(HandoffErrorCode.InvalidState, problem, { handoff: failed });
    }
    // `running` is recorded by observeConversation once the receiver starts.
    return result;
  }

  /** Drops a prepared handoff. The original owner stays in charge. */
  cancel(input: { handoffId: string }): Handoff {
    const handoff = this.require(input.handoffId);
    if (handoff.state !== 'prepared') {
      throw new RpcError(HandoffErrorCode.InvalidState, '这个交接不在待确认状态');
    }
    this.deps.conversations.releaseHold(handoff.conversationId);
    return this.abort(handoff, this.currentConversation(handoff.conversationId), '用户取消了交接');
  }

  /**
   * Follows a committed handoff. The receiver is running → `running`; its
   * first run failed → `needs_reconciliation` (the owner already changed, so
   * this is never reported as a failed handoff).
   */
  observeConversation(conversation: Conversation): void {
    if (!this.booted) return;
    const [latest] = this.deps.store.listHandoffs(conversation.id);
    if (!latest || latest.state !== 'committed') return;
    if (conversation.state === 'failed') {
      const problem = '接手方启动后运行失败，任务负责人仍是接手方。请检查后重试或反向交接。';
      this.deps.store.updateHandoff(
        latest.id,
        { state: 'needs_reconciliation', problem },
        latest.version,
        this.deps.now(),
      );
      this.deps.conversations.recordHandoffEvent(conversation.id, {
        type: 'handoff',
        handoffId: latest.id,
        fromHarnessId: latest.fromHarnessId,
        toHarnessId: latest.toHarnessId,
        goal: latest.package?.goal ?? conversation.title,
        state: 'needs_reconciliation',
        problem,
      });
      return;
    }
    if (conversation.state === 'running' || conversation.state === 'waiting_user') {
      this.deps.store.updateHandoff(
        latest.id,
        { state: 'running' },
        latest.version,
        this.deps.now(),
      );
    }
  }

  /**
   * Boot-time reconciliation. A handoff interrupted before commit leaves the
   * original owner; one interrupted after commit keeps the receiver and is
   * reported as needing the user's attention. Nothing is retried silently.
   */
  reconcile(): void {
    for (const handoff of this.deps.store.listOpenHandoffs()) {
      const conversation = this.currentConversation(handoff.conversationId);
      this.deps.conversations.releaseHold(conversation.id);
      // The owner column decides which side of the commit a crash left us on;
      // the handoff state alone cannot (committed is written in that transaction).
      if (conversation.harnessId === handoff.toHarnessId) {
        if (handoff.state === 'running') continue;
        const problem = '应用退出时接手方尚未开始运行。负责人已切换到接手方。';
        this.deps.store.updateHandoff(
          handoff.id,
          { state: 'needs_reconciliation', problem },
          handoff.version,
          this.deps.now(),
        );
        this.deps.conversations.recordHandoffEvent(conversation.id, {
          type: 'handoff',
          handoffId: handoff.id,
          fromHarnessId: handoff.fromHarnessId,
          toHarnessId: handoff.toHarnessId,
          goal: handoff.package?.goal ?? conversation.title,
          state: 'needs_reconciliation',
          problem,
        });
        continue;
      }
      this.abort(
        handoff,
        conversation,
        handoff.state === 'stopping_source'
          ? '应用退出时交接尚未确认，任务仍由原 Agent 负责'
          : '应用退出时交接未提交，任务仍由原 Agent 负责',
      );
    }
    this.booted = true;
  }

  // --- internals ---

  private preparedFor(conversationId: string): Handoff | null {
    return (
      this.deps.store
        .listHandoffs(conversationId)
        .find((h) => h.state === 'prepared' || h.state === 'stopping_source') ?? null
    );
  }

  private abort(handoff: Handoff, conversation: Conversation, problem: string): Handoff {
    const aborted = this.deps.store.updateHandoff(
      handoff.id,
      { state: 'aborted', problem },
      handoff.version,
      this.deps.now(),
    );
    this.deps.conversations.recordHandoffEvent(conversation.id, {
      type: 'handoff',
      handoffId: handoff.id,
      fromHarnessId: handoff.fromHarnessId,
      toHarnessId: handoff.toHarnessId,
      goal: handoff.package?.goal ?? conversation.title,
      state: 'aborted',
      problem,
    });
    return aborted;
  }

  private require(id: string): Handoff {
    const handoff = this.deps.store.getHandoff(id);
    if (!handoff) throw new RpcError(HandoffErrorCode.NotFound, `交接不存在：${id}`);
    return handoff;
  }

  private currentConversation(id: string): Conversation {
    return this.deps.conversations.get(id);
  }
}
