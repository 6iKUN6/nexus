import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type AdapterSession,
  type AgentAdapter,
  type Conversation,
  type ConversationEvent,
  type ConversationEventBody,
  type HarnessId,
  type Isolation,
  RpcError,
  type StopResult,
} from '@nexus/protocol';
import type { ConversationPatch, Store } from '../store/store';
import { findRepoRoot, type GitRun, type WorktreeManager } from '../worktree/gitWorktree';

/**
 * Owns conversation lifecycle: one serial prompt queue per conversation,
 * adapter sessions, persistence of every event, and recovery after restart.
 * Independent conversations run in parallel.
 */

export const ErrorCode = {
  NotFound: 4004,
  Unsupported: 4005,
  InvalidCwd: 4006,
  NotARepo: 4007,
  WorktreeFailed: 4008,
  CwdInUse: 4009,
  PermissionExpired: 4010,
} as const;

export type HarnessRuntime = {
  executablePath: string | null;
  env: Record<string, string>;
};

export type ConversationServiceDeps = {
  store: Store;
  adapters: Partial<Record<HarnessId, AgentAdapter>>;
  /** Resolves the executable and environment for a harness at run time. */
  runtimeFor: (harnessId: HarnessId) => Promise<HarnessRuntime>;
  /** Creates isolated worktrees (ADR 0006). */
  worktrees: WorktreeManager;
  /** git runner for repo detection; injected in tests. */
  gitRun: GitRun;
  onEvent: (event: ConversationEvent) => void;
  onConversation: (conversation: Conversation) => void;
  /** Runs allowed to execute at once across all conversations. Defaults to 3. */
  maxConcurrentRuns?: number;
  now?: () => number;
  newId?: () => string;
};

type QueuedPrompt = { runId: string; text: string };

type Live = {
  session: AdapterSession | null;
  activeRunId: string | null;
  queue: QueuedPrompt[];
};

const PREVIEW_MAX = 80;
const DEFAULT_TITLE = '新会话';

export class ConversationService {
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxConcurrentRuns: number;
  /** Conversations with a run in flight (started or waiting for a slot). */
  private readonly running = new Set<string>();
  /** Runs waiting for a free slot, FIFO across conversations. */
  private waiting: Array<{ conversationId: string; prompt: QueuedPrompt }> = [];
  /**
   * Set while shutting down. Aborting a session makes adapters emit a terminal
   * `cancelled` event; persisting it would make an interrupted run look like a
   * clean user cancel. During shutdown events are dropped instead, so the next
   * boot's recovery closes those runs as `interrupted` (ADR 0005 §5).
   */
  private disposing = false;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.maxConcurrentRuns = deps.maxConcurrentRuns ?? 3;
  }

  list(): Conversation[] {
    return this.deps.store.listConversations();
  }

  get(conversationId: string): Conversation {
    return this.require(conversationId);
  }

  /**
   * Records a task lifecycle event on a conversation's log (M3). TaskService
   * drives this; task events never change the conversation's run state.
   */
  recordTaskEvent(
    conversationId: string,
    body: Extract<ConversationEventBody, { type: 'task.delegated' | 'task.updated' }>,
  ): void {
    this.require(conversationId);
    const preview =
      body.type === 'task.delegated'
        ? truncate(`委派子任务：${body.goal}`)
        : body.status === 'review'
          ? '子任务完成，待验收'
          : body.status === 'failed'
            ? '子任务失败'
            : body.status === 'accepted'
              ? '子任务已通过验收'
              : '子任务继续进行中';
    this.append(conversationId, body, { preview });
  }

  events(conversationId: string, afterSeq: number): ConversationEvent[] {
    this.require(conversationId);
    return this.deps.store.listEvents(conversationId, afterSeq);
  }

  async create(input: {
    harnessId: HarnessId;
    cwd: string;
    isolation?: Isolation | undefined;
    title?: string | undefined;
  }) {
    if (!this.deps.adapters[input.harnessId]) {
      throw new RpcError(ErrorCode.Unsupported, `暂不支持在 ${input.harnessId} 中创建会话`);
    }
    const cwd = input.cwd.replace(/\/+$/, '');
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) {
      throw new RpcError(ErrorCode.InvalidCwd, `工作目录不存在或不是文件夹：${input.cwd}`);
    }
    const isolation = input.isolation ?? 'direct';
    const id = this.newId();
    let actualCwd = cwd;
    let baseCwd: string | null = null;
    if (isolation === 'worktree') {
      try {
        actualCwd = (await this.deps.worktrees.create(cwd, id)).cwd;
        baseCwd = cwd;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.includes('不是 git 仓库')
          ? ErrorCode.NotARepo
          : ErrorCode.WorktreeFailed;
        throw new RpcError(code, message);
      }
    } else {
      // One writer per directory: a second direct conversation on the same
      // cwd is rejected; worktree conversations are isolated by construction.
      const inUse = this.deps.store
        .listConversations()
        .some((c) => c.isolation === 'direct' && c.cwd === cwd);
      if (inUse) {
        throw new RpcError(
          ErrorCode.CwdInUse,
          '已有会话直接在此目录运行。为避免两个 Agent 同时改写同一目录，请改用 worktree 隔离。',
        );
      }
    }
    const now = this.now();
    const conversation: Conversation = {
      id,
      title: input.title ?? DEFAULT_TITLE,
      harnessId: input.harnessId,
      cwd: actualCwd,
      isolation,
      baseCwd,
      externalSessionId: null,
      state: 'idle',
      lastSeq: 0,
      preview: `工作目录 ${basename(actualCwd)}`,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertConversation(conversation);
    this.deps.onConversation(conversation);
    return conversation;
  }

  /** What the new-conversation dialog needs to know about a directory. */
  async inspectPath(cwd: string) {
    const trimmed = cwd.replace(/\/+$/, '');
    const info = await stat(trimmed).catch(() => null);
    const exists = Boolean(info?.isDirectory());
    const repoRoot = exists ? await findRepoRoot(this.deps.gitRun, trimmed) : null;
    const directInUse = this.deps.store
      .listConversations()
      .some((c) => c.isolation === 'direct' && c.cwd === trimmed);
    return { exists, isGitRepo: repoRoot !== null, repoRoot, directInUse };
  }

  send(conversationId: string, text: string) {
    const conversation = this.require(conversationId);
    const live = this.liveFor(conversationId);
    const messageId = this.newId();
    const runId = this.newId();
    const title =
      conversation.title === DEFAULT_TITLE && conversation.lastSeq === 0
        ? text.replace(/\s+/g, ' ').slice(0, 30)
        : conversation.title;
    this.append(
      conversationId,
      { type: 'user.message', messageId, text },
      { title, preview: text },
    );

    // A prompt is queued when its conversation is busy, or when every global
    // run slot is taken (plan §7: at most 3 harness processes at once).
    const busy = live.activeRunId !== null;
    const hasSlot = this.running.size < this.maxConcurrentRuns;
    const queued = busy || !hasSlot;
    if (queued) this.append(conversationId, { type: 'run.queued', runId, messageId }, {});
    if (busy) {
      live.queue.push({ runId, text });
    } else {
      live.activeRunId = runId;
      if (hasSlot) {
        this.running.add(conversationId);
        void this.run(conversationId, { runId, text });
      } else {
        this.waiting.push({ conversationId, prompt: { runId, text } });
      }
    }
    return { messageId, runId, queued };
  }

  async cancel(conversationId: string): Promise<boolean> {
    this.require(conversationId);
    const live = this.live.get(conversationId);
    const runId = live?.activeRunId;
    if (!live || !runId) return false;
    if (live.session) {
      await live.session.cancel(runId);
      return true;
    }
    // Waiting for a global run slot: nothing has started, so there is no
    // process to signal. Drop it and close the run as cancelled.
    const index = this.waiting.findIndex(
      (w) => w.conversationId === conversationId && w.prompt.runId === runId,
    );
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    live.activeRunId = null;
    this.append(
      conversationId,
      { type: 'run.completed', runId, stopReason: 'cancelled' },
      { state: 'idle', preview: '已停止运行' },
    );
    this.nextInConversation(conversationId);
    return true;
  }

  async respondToPermission(conversationId: string, requestId: string, optionId: string) {
    this.require(conversationId);
    const live = this.live.get(conversationId);
    const runId = live?.activeRunId;
    if (!live?.session?.respondToPermission || !runId) {
      throw new RpcError(ErrorCode.PermissionExpired, '这个权限请求已失效');
    }
    try {
      await live.session.respondToPermission(requestId, optionId);
    } catch (error) {
      throw new RpcError(
        ErrorCode.PermissionExpired,
        error instanceof Error ? error.message : '这个权限请求已失效',
      );
    }
    this.append(
      conversationId,
      { type: 'permission.resolved', runId, requestId, optionId },
      { state: 'running' },
    );
  }

  /**
   * After a restart nothing is running. Any run that started (or was queued)
   * without a terminal event is closed as interrupted, never re-executed:
   * it may already have changed files (plan §10.5).
   */
  recoverInterruptedRuns(): number {
    let recovered = 0;
    for (const conversation of this.deps.store.listConversations()) {
      if (conversation.state !== 'running' && conversation.state !== 'waiting_user') {
        continue;
      }
      const open = new Set<string>();
      for (const { body } of this.deps.store.listEvents(conversation.id, 0)) {
        if (body.type === 'run.queued' || body.type === 'run.started') open.add(body.runId);
        if (body.type === 'run.completed' || body.type === 'run.failed') open.delete(body.runId);
      }
      for (const runId of open) {
        this.append(
          conversation.id,
          {
            type: 'run.failed',
            runId,
            error: {
              code: 'interrupted',
              message: '应用退出时这次运行被中断，没有自动重试。请检查工作目录后再继续。',
            },
          },
          { state: 'failed' },
        );
        recovered++;
      }
      if (open.size === 0)
        this.deps.store.updateConversation(conversation.id, { state: 'idle' }, this.now());
    }
    return recovered;
  }

  /**
   * Stops the live harness process of a conversation and reports whether it is
   * verified gone (handoff depends on this, ADR 0010). The session object is
   * dropped either way, so the next prompt starts a fresh one.
   */
  async stopSession(conversationId: string): Promise<StopResult> {
    this.require(conversationId);
    const live = this.live.get(conversationId);
    const session = live?.session;
    // A run waiting for a global slot has no process; drop it too, or it would
    // start later in a session the caller believes is stopped.
    this.waiting = this.waiting.filter((w) => w.conversationId !== conversationId);
    this.running.delete(conversationId);
    this.live.delete(conversationId);
    if (!session) return { confirmed: true, problem: null };
    return session.dispose();
  }

  /** Disposes every live session. Returns the outcomes that could not be confirmed. */
  async disposeSessions(): Promise<StopResult[]> {
    this.disposing = true;
    const sessions = [...this.live.values()].flatMap((live) =>
      live.session ? [live.session] : [],
    );
    this.live.clear();
    const outcomes = await Promise.allSettled(sessions.map((session) => session.dispose()));
    return outcomes.flatMap((outcome) =>
      outcome.status === 'rejected'
        ? [
            {
              confirmed: false,
              problem: `停止会话时出错：${
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
              }`,
            },
          ]
        : [outcome.value],
    );
  }

  async dispose(): Promise<void> {
    await this.disposeSessions();
  }

  // --- internals ---

  private require(conversationId: string): Conversation {
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation) throw new RpcError(ErrorCode.NotFound, `会话不存在：${conversationId}`);
    return conversation;
  }

  private liveFor(conversationId: string): Live {
    let live = this.live.get(conversationId);
    if (!live) {
      live = { session: null, activeRunId: null, queue: [] };
      this.live.set(conversationId, live);
    }
    return live;
  }

  private append(conversationId: string, body: ConversationEventBody, patch: ConversationPatch) {
    if (this.disposing) return;
    const derived = { ...deriveFromEvent(body), ...patch };
    const before = this.deps.store.getConversation(conversationId);
    const { event, conversation } = this.deps.store.appendEvent(
      conversationId,
      body,
      derived,
      this.now(),
    );
    this.deps.onEvent(event);
    const changed =
      !before ||
      before.state !== conversation.state ||
      before.preview !== conversation.preview ||
      before.title !== conversation.title ||
      before.externalSessionId !== conversation.externalSessionId ||
      body.type !== 'text.delta';
    if (changed) this.deps.onConversation(conversation);
  }

  private async sessionFor(conversation: Conversation, live: Live): Promise<AdapterSession> {
    if (live.session) return live.session;
    const adapter = this.deps.adapters[conversation.harnessId];
    if (!adapter) throw new Error(`No adapter for ${conversation.harnessId}`);
    const runtime = await this.deps.runtimeFor(conversation.harnessId);
    const options = { cwd: conversation.cwd, ...runtime };
    const session =
      conversation.externalSessionId && adapter.resumeSession
        ? await adapter.resumeSession(conversation.externalSessionId, options)
        : await adapter.createSession(options);
    live.session = session;
    if (session.externalId !== conversation.externalSessionId) {
      const updated = this.deps.store.updateConversation(
        conversation.id,
        { externalSessionId: session.externalId },
        this.now(),
      );
      this.deps.onConversation(updated);
    }
    return session;
  }

  /** Starts waiting runs in FIFO order while slots are free. */
  private pump(): void {
    while (this.waiting.length > 0 && this.running.size < this.maxConcurrentRuns) {
      const next = this.waiting.shift();
      if (!next) return;
      this.running.add(next.conversationId);
      void this.run(next.conversationId, next.prompt);
    }
  }

  /** Starts the next prompt typed in this conversation while it was busy. */
  private nextInConversation(conversationId: string): void {
    const live = this.live.get(conversationId);
    const next = live?.queue.shift();
    if (!live || !next) return;
    live.activeRunId = next.runId;
    if (this.running.size < this.maxConcurrentRuns) {
      this.running.add(conversationId);
      void this.run(conversationId, next);
    } else {
      // Its `run.queued` event was recorded when it was sent; it stays queued
      // until a slot frees up.
      this.waiting.push({ conversationId, prompt: next });
    }
  }

  private async run(conversationId: string, prompt: QueuedPrompt): Promise<void> {
    const live = this.liveFor(conversationId);
    let terminal = false;
    try {
      const session = await this.sessionFor(this.require(conversationId), live);
      let reply = '';
      for await (const event of session.sendPrompt({ runId: prompt.runId, text: prompt.text })) {
        if (event.runId !== prompt.runId || terminal) continue;
        if (event.type === 'text.delta' && reply.length < PREVIEW_MAX * 2) reply += event.text;
        if (event.type === 'run.completed' || event.type === 'run.failed') terminal = true;
        const finishedWithReply =
          event.type === 'run.completed' && event.stopReason !== 'cancelled' && reply.trim();
        this.append(conversationId, event, finishedWithReply ? { preview: truncate(reply) } : {});
      }
    } catch (error) {
      if (!terminal) {
        terminal = true;
        this.append(
          conversationId,
          {
            type: 'run.failed',
            runId: prompt.runId,
            error: {
              code: 'adapter_error',
              message: error instanceof Error ? error.message : String(error),
            },
          },
          {},
        );
      }
    }
    if (!terminal) {
      this.append(
        conversationId,
        {
          type: 'run.failed',
          runId: prompt.runId,
          error: { code: 'no_terminal_event', message: '运行结束时没有收到完成事件，结果未知。' },
        },
        {},
      );
    }
    live.activeRunId = null;
    this.running.delete(conversationId);
    // Free slot first, so a globally waiting run can take it; then this
    // conversation's own queue (which is FIFO per conversation).
    this.pump();
    this.nextInConversation(conversationId);
  }
}

/** Conversation metadata implied by an event. */
function deriveFromEvent(body: ConversationEventBody): ConversationPatch {
  switch (body.type) {
    case 'run.started':
      return { state: 'running' };
    case 'permission.requested':
    case 'input.requested':
      return {
        state: 'waiting_user',
        preview: truncate(
          body.type === 'permission.requested' ? `等待授权：${body.description}` : body.prompt,
        ),
      };
    case 'run.completed':
      return {
        state: 'idle',
        ...(body.stopReason === 'cancelled' ? { preview: '已停止运行' } : {}),
      };
    case 'run.failed':
      return { state: 'failed', preview: truncate(`运行失败：${body.error.message}`) };
    case 'tool.started':
      return { preview: truncate(`正在使用 ${body.name}`) };
    default:
      return {};
  }
}

function truncate(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line;
}
