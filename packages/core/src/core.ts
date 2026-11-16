import { randomUUID } from 'node:crypto';
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
import { startCollaborationServer } from './collaboration/server';
import { CollaborationService } from './collaboration/service';
import { writeHelperShim } from './collaboration/shim';
import { SessionTokens } from './collaboration/tokens';
import { ConversationService, type HarnessRuntime } from './conversations/conversationService';
import { exportDiagnostics } from './diagnostics/diagnostics';
import { installLogCapture } from './diagnostics/logBuffer';
import { harnessEnvironment } from './env/harnessEnvironment';
import { resolveLoginShellEnv } from './env/loginShellEnv';
import { resolveLoginShellPath } from './env/loginShellPath';
import { HandoffService } from './handoff/handoffService';
import { detectHarnesses, nodeDetectDeps } from './harness/detect';
import { McpService } from './mcp/mcpService';
import { MessageService } from './messaging/messageService';
import { Store } from './store/store';
import { TaskService } from './tasks/taskService';
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
  /** Where diagnostic bundles are written. Defaults next to the database. */
  diagnosticsDir?: string;
  /**
   * Enables the agent collaboration channel (D14). `helperScript` is the built
   * helper bundle and `runner` the executable able to run it (Electron-as-Node
   * in the app). Core generates the `nexus-helper` launcher itself; the socket
   * defaults to `<database dir>/nexus.sock`.
   */
  collaboration?: {
    helperScript: string;
    runner: { command: string; args?: string[]; env?: Record<string, string> };
    socketPath?: string;
  };
  /** Injected in tests; defaults to real PATH resolution + filesystem detection. */
  detectHarnesses?: (pathValue: string) => Promise<HarnessInfo[]>;
  resolvePath?: () => Promise<string>;
  /** Login-shell environment for MCP placeholder resolution (D23). */
  resolveEnv?: () => Promise<Record<string, string>>;
  worktrees?: WorktreeManager;
  gitRun?: GitRun;
  /** Global cap on concurrent harness runs (plan §7). Defaults to 3. */
  maxConcurrentRuns?: number;
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
  const resolveEnv = options.resolveEnv ?? (() => resolveLoginShellEnv());
  const startedAt = now();
  const ports = new Set<RpcPort>();

  let pathValue: Promise<string> | null = null;
  let envValue: Promise<Record<string, string>> | null = null;
  let harnesses: Promise<HarnessInfo[]> | null = null;

  const loadPath = () => {
    pathValue ??= resolvePath();
    return pathValue;
  };

  const loadEnv = () => {
    envValue ??= resolveEnv();
    return envValue;
  };

  const loadHarnesses = (refresh: boolean) => {
    if (refresh || !harnesses) {
      if (refresh) pathValue = null;
      const attempt = loadPath().then(async (path) => {
        const detected = await detect(path);
        const all = options.adapters.fake ? [...detected, FAKE_HARNESS] : detected;
        return Promise.all(
          all.map(async (h) => {
            const adapter = options.adapters[h.id];
            if (!adapter) return h;
            const base = { ...h, chatSupported: h.installed };
            try {
              const probe = await adapter.probe();
              return {
                ...base,
                version: h.version ?? probe.version,
                auth: probe.auth !== 'unknown' ? probe.auth : h.auth,
                capabilities: probe.capabilities,
                limitations: probe.limitations,
              };
            } catch {
              // A failing probe must not hide detection results.
              return base;
            }
          }),
        );
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
  const diagnosticsDir =
    options.diagnosticsDir ??
    (options.databasePath === ':memory:'
      ? mkdtempSync(join(tmpdir(), 'nexus-diagnostics-'))
      : join(dirname(options.databasePath), 'diagnostics'));
  // Packaged builds have no terminal on stderr; keep recent lines for export.
  installLogCapture();
  const socketPath =
    options.collaboration?.socketPath ??
    (options.databasePath === ':memory:'
      ? join(tmpdir(), `nexus-collab-${randomUUID()}.sock`)
      : join(dirname(options.databasePath), 'nexus.sock'));
  const sessionTokens = new SessionTokens();
  const helperDir =
    options.databasePath === ':memory:'
      ? join(tmpdir(), `nexus-helper-${randomUUID()}`)
      : join(dirname(options.databasePath), 'bin');
  const helperPath = join(helperDir, 'nexus-helper');
  if (options.collaboration) {
    writeHelperShim(helperPath, options.collaboration.runner, options.collaboration.helperScript);
  }
  let tasks: TaskService | null = null;
  let handoffs: HandoffService | null = null;
  let messageService: MessageService | null = null;
  const mcpServers = new McpService({ store, loginEnv: loadEnv, now });
  const conversations = new ConversationService({
    store,
    adapters: options.adapters,
    now,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.maxConcurrentRuns === undefined
      ? {}
      : { maxConcurrentRuns: options.maxConcurrentRuns }),
    worktrees: options.worktrees ?? createWorktreeManager(worktreeDir, options.gitRun),
    gitRun: options.gitRun ?? realGitRun,
    mcpServers,
    runtimeFor: async (harnessId): Promise<HarnessRuntime> => {
      const [path, list] = await Promise.all([loadPath(), loadHarnesses(false)]);
      const info = list.find((h) => h.id === harnessId);
      return { executablePath: info?.executablePath ?? null, env: harnessEnvironment(path) };
    },
    ...(options.collaboration
      ? {
          collaboration: {
            socketPath,
            helperPath,
            issueToken: (conversationId: string) => sessionTokens.issue(conversationId),
            revokeToken: (token: string) => sessionTokens.revoke(token),
          },
        }
      : {}),
    onEvent: (event) => {
      broadcast('conversation.event', event);
      messageService?.observeEvent(event);
    },
    onConversation: (conversation) => {
      broadcast('conversation.updated', conversation);
      tasks?.observeConversation(conversation);
      handoffs?.observeConversation(conversation);
    },
  });
  const taskService = new TaskService({
    store,
    conversations,
    gitRun: options.gitRun ?? realGitRun,
    now,
    newId: options.newId ?? randomUUID,
  });
  tasks = taskService;
  const handoffService = new HandoffService({
    store,
    conversations,
    adapters: options.adapters,
    gitRun: options.gitRun ?? realGitRun,
    now,
    newId: options.newId ?? randomUUID,
  });
  handoffs = handoffService;
  const messages = new MessageService({
    store,
    conversations,
    now,
    ...(options.newId ? { newId: options.newId } : {}),
  });
  messageService = messages;
  const collaboration = new CollaborationService({
    conversations,
    tasks: taskService,
    messages,
    isHarnessSupported: (harnessId) => Boolean(options.adapters[harnessId]),
    ...(options.newId ? { newId: options.newId } : {}),
  });
  const collabServer = options.collaboration
    ? startCollaborationServer({
        socketPath,
        tokens: sessionTokens,
        handlers: collaboration.handlers,
      })
    : null;
  conversations.recoverInterruptedRuns();
  // Tasks whose child settled while core was down still get their transition.
  taskService.reconcile();
  // Handoffs interrupted by the exit: before the commit the original owner
  // stays, after it the receiver does (plan §7). Nothing is retried.
  handoffService.reconcile();
  // Messages whose delivery outcome died with the previous process become
  // needs_check; nothing is resent silently (ADR 0017).
  messages.reconcile();

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
    'conversation.configure': (params) => ({ conversation: conversations.configure(params) }),
    'conversation.send': ({ conversationId, text }) => conversations.send(conversationId, text),
    'conversation.cancel': async ({ conversationId }) => ({
      cancelled: await conversations.cancel(conversationId),
    }),
    'permission.respond': async ({ conversationId, requestId, optionId }) => {
      await conversations.respondToPermission(conversationId, requestId, optionId);
      return {};
    },
    'task.delegate': async (params) => {
      const { task, childConversation } = await taskService.delegate(params);
      return { task, childConversation };
    },
    'task.list': ({ conversationId }) => taskService.list(conversationId),
    'task.inbox': () => ({ items: taskService.inbox() }),
    'task.respond': (params) => taskService.respond(params),
    'task.evidence': async ({ taskId }) => ({ evidence: await taskService.evidence(taskId) }),
    'message.list': ({ conversationId }) => ({ messages: messages.list(conversationId) }),
    'mcp.list': async () => ({ servers: await mcpServers.list() }),
    'mcp.upsert': async ({ server }) => ({ server: await mcpServers.upsert(server) }),
    'mcp.remove': ({ id }) => ({ removed: mcpServers.remove(id) }),
    'message.resend': ({ messageId }) => ({ message: messages.resend(messageId) }),
    'handoff.suggest': (params) => handoffService.suggest(params.conversationId),
    'handoff.prepare': async (params) => ({ handoff: await handoffService.prepare(params) }),
    'handoff.commit': async (params) => handoffService.commit(params),
    'handoff.cancel': (params) => ({ handoff: handoffService.cancel(params) }),
    'diagnostics.export': ({ conversationId }) =>
      exportDiagnostics(
        {
          store,
          version: options.version,
          harnesses: () => loadHarnesses(false),
          diagnosticsDir,
          maxConcurrentRuns: options.maxConcurrentRuns ?? 3,
          databasePath: options.databasePath,
          ...(options.now ? { now: options.now } : {}),
        },
        conversationId,
      ),
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
      // Stop the socket first: no new tool calls while sessions are torn down.
      await collabServer?.close();
      await conversations.dispose();
      store.close();
    },
  };
}
