import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AgentAdapter,
  HarnessId,
  HarnessInfo,
  RpcHandlers,
  RpcNotification,
  RpcNotificationParams,
  RpcPort,
} from '@nexus/protocol';
import { sendNotification, serveRpc } from '@nexus/protocol';
import { ConversationService, type HarnessRuntime } from './conversations/conversationService';
import { harnessEnvironment } from './env/harnessEnvironment';
import { resolveLoginShellPath } from './env/loginShellPath';
import { detectHarnesses, nodeDetectDeps } from './harness/detect';
import { Store } from './store/store';
import {
  createWorktreeManager,
  type GitRun,
  realGitRun,
  type WorktreeManager,
} from './worktree/gitWorktree';

export type CoreOptions = {
  version: string;
  /** SQLite file path, or ':memory:' in tests. */
  databasePath: string;
  adapters: Partial<Record<HarnessId, AgentAdapter>>;
  /** Where isolated worktrees are created (ADR 0006). Defaults next to the database. */
  worktreeDir?: string;
  /** Injected in tests; defaults to real PATH resolution + filesystem detection. */
  detectHarnesses?: (pathValue: string) => Promise<HarnessInfo[]>;
  resolvePath?: () => Promise<string>;
  worktrees?: WorktreeManager;
  gitRun?: GitRun;
  now?: () => number;
  newId?: () => string;
};

export type Core = {
  /** Serves the core API on a port. One core can serve many windows. Returns a detach function. */
  attach(port: RpcPort): () => void;
  dispose(): Promise<void>;
};

const FAKE_HARNESS: HarnessInfo = {
  id: 'fake',
  displayName: 'Fake（开发用）',
  binaryName: 'fake',
  installed: true,
  executablePath: null,
  version: '0.0.0',
  auth: 'authenticated',
  problem: null,
  chatSupported: true,
};

export function createCore(options: CoreOptions): Core {
  const now = options.now ?? Date.now;
  const detect = options.detectHarnesses ?? ((path) => detectHarnesses(nodeDetectDeps(path)));
  const resolvePath = options.resolvePath ?? (() => resolveLoginShellPath());
  const startedAt = now();
  const ports = new Set<RpcPort>();

  let pathValue: Promise<string> | null = null;
  let harnesses: Promise<HarnessInfo[]> | null = null;

  const loadPath = () => {
    pathValue ??= resolvePath();
    return pathValue;
  };

  const loadHarnesses = (refresh: boolean) => {
    if (refresh || !harnesses) {
      if (refresh) pathValue = null;
      const attempt = loadPath().then(async (path) => {
        const detected = (await detect(path)).map((h) => ({
          ...h,
          chatSupported: Boolean(options.adapters[h.id]) && h.installed,
        }));
        return options.adapters.fake ? [...detected, FAKE_HARNESS] : detected;
      });
      harnesses = attempt;
      // Do not cache failures; the next call retries.
      attempt.catch(() => {
        if (harnesses === attempt) harnesses = null;
      });
    }
    return harnesses;
  };

  const broadcast = <N extends RpcNotification>(method: N, params: RpcNotificationParams<N>) => {
    for (const port of ports) sendNotification(port, method, params);
  };

  const store = new Store(options.databasePath);
  const worktreeDir =
    options.worktreeDir ??
    (options.databasePath === ':memory:'
      ? mkdtempSync(join(tmpdir(), 'nexus-worktrees-'))
      : join(dirname(options.databasePath), 'worktrees'));
  const conversations = new ConversationService({
    store,
    adapters: options.adapters,
    now,
    ...(options.newId ? { newId: options.newId } : {}),
    worktrees: options.worktrees ?? createWorktreeManager(worktreeDir, options.gitRun),
    gitRun: options.gitRun ?? realGitRun,
    runtimeFor: async (harnessId): Promise<HarnessRuntime> => {
      const [path, list] = await Promise.all([loadPath(), loadHarnesses(false)]);
      const info = list.find((h) => h.id === harnessId);
      return { executablePath: info?.executablePath ?? null, env: harnessEnvironment(path) };
    },
    onEvent: (event) => broadcast('conversation.event', event),
    onConversation: (conversation) => broadcast('conversation.updated', conversation),
  });
  conversations.recoverInterruptedRuns();

  const handlers: RpcHandlers = {
    'system.ping': () => ({
      coreVersion: options.version,
      uptimeMs: Math.max(0, now() - startedAt),
    }),
    'harness.list': async ({ refresh }) => ({ harnesses: await loadHarnesses(refresh) }),
    'conversation.list': () => ({ conversations: conversations.list() }),
    'conversation.create': async (params) => ({ conversation: await conversations.create(params) }),
    'path.inspect': ({ cwd }) => conversations.inspectPath(cwd),
    'conversation.events': ({ conversationId, afterSeq }) => ({
      events: conversations.events(conversationId, afterSeq),
    }),
    'conversation.send': ({ conversationId, text }) => conversations.send(conversationId, text),
    'conversation.cancel': async ({ conversationId }) => ({
      cancelled: await conversations.cancel(conversationId),
    }),
    'permission.respond': async ({ conversationId, requestId, optionId }) => {
      await conversations.respondToPermission(conversationId, requestId, optionId);
      return {};
    },
  };

  return {
    attach(port) {
      ports.add(port);
      const stop = serveRpc(port, handlers);
      return () => {
        stop();
        ports.delete(port);
      };
    },
    async dispose() {
      await conversations.dispose();
      store.close();
    },
  };
}
