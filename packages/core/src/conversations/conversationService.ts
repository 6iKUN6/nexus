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
  RpcError,
} from '@nexus/protocol';
import type { ConversationPatch, Store } from '../store/store';

/**
 * Owns conversation lifecycle: one serial prompt queue per conversation,
 * adapter sessions, persistence of every event, and recovery after restart.
 * Independent conversations run in parallel.
 */

export const ErrorCode = {
  NotFound: 4004,
  Unsupported: 4005,
  InvalidCwd: 4006,
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
  onEvent: (event: ConversationEvent) => void;
  onConversation: (conversation: Conversation) => void;
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

  constructor(private readonly deps: ConversationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  list(): Conversation[] {
    return this.deps.store.listConversations();
  }

  events(conversationId: string, afterSeq: number): ConversationEvent[] {
    this.require(conversationId);
    return this.deps.store.listEvents(conversationId, afterSeq);
  }

  async create(input: { harnessId: HarnessId; cwd: string; title?: string | undefined }) {
    if (!this.deps.adapters[input.harnessId]) {
      throw new RpcError(ErrorCode.Unsupported, `暂不支持在 ${input.harnessId} 中创建会话`);
    }
    const info = await stat(input.cwd).catch(() => null);
    if (!info?.isDirectory()) {
      throw new RpcError(ErrorCode.InvalidCwd, `工作目录不存在或不是文件夹：${input.cwd}`);
    }
    const now = this.now();
    const conversation: Conversation = {
      id: this.newId(),
      title: input.title ?? DEFAULT_TITLE,
      harnessId: input.harnessId,
      cwd: input.cwd,
      externalSessionId: null,
      state: 'idle',
      lastSeq: 0,
      preview: `工作目录 ${basename(input.cwd)}`,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertConversation(conversation);
    this.deps.onConversation(conversation);
    return conversation;
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

    const queued = live.activeRunId !== null;
    if (queued) {
      live.queue.push({ runId, text });
      this.append(conversationId, { type: 'run.queued', runId, messageId }, {});
    } else {
      void this.run(conversationId, { runId, text });
    }
    return { messageId, runId, queued };
  }

  async cancel(conversationId: string): Promise<boolean> {
    this.require(conversationId);
    const live = this.live.get(conversationId);
    if (!live?.activeRunId || !live.session) return false;
    await live.session.cancel(live.activeRunId);
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

  async dispose(): Promise<void> {
    await Promise.all([...this.live.values()].map((live) => live.session?.dispose()));
    this.live.clear();
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

  private async run(conversationId: string, prompt: QueuedPrompt): Promise<void> {
    const live = this.liveFor(conversationId);
    live.activeRunId = prompt.runId;
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
    const next = live.queue.shift();
    if (next) void this.run(conversationId, next);
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
