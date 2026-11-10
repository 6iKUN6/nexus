import { spawn } from 'node:child_process';
import type {
  AdapterSession,
  AgentAdapter,
  AgentEvent,
  CreateSessionOptions,
  PermissionOption,
  ProbeResult,
} from '@nexus/protocol';
import { AsyncQueue } from './asyncQueue';
import { createRunMapper } from './mapEvents';
import { createStdioJsonRpc, type StdioJsonRpc } from './stdioJsonRpc';

/**
 * Codex adapter on `codex app-server` (stdio JSON-RPC; probed against
 * codex-cli 0.154.0, see probes/output/codex/appserver-*).
 *
 * One app-server process per session; the thread id is the external session
 * id, so a restart re-attaches with `thread/resume`. Approvals arrive as
 * server-initiated JSON-RPC requests and are answered when the user picks an
 * option on the permission card.
 *
 * Approval policy is pinned to `on-request` + `workspace-write` sandbox: the
 * user's own codex config may be more permissive (e.g. never ask), but Nexus
 * must see every escalation to show a permission card (same precedent as the
 * Claude adapter forcing permissionMode 'default').
 */

export type CodexAdapterOptions = {
  /** Injected in tests. */
  spawnImpl?: typeof spawn;
};

type ApprovalKind = 'commandExecution' | 'fileChange' | 'legacyExec' | 'legacyPatch';

type PendingApproval = {
  runId: string;
  kind: ApprovalKind;
  /** Id of the server-initiated JSON-RPC request to answer. */
  requestWireId: number | string;
  allowedOptions: Set<string>;
};

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
  { id: 'allow_always', label: '本会话始终允许', kind: 'allow_always' },
  { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
];

function decisionFor(kind: ApprovalKind, optionId: string): unknown {
  if (kind === 'legacyExec' || kind === 'legacyPatch') {
    if (optionId === 'allow_always') return { decision: 'approved_for_session' };
    if (optionId === 'reject_once') {
      return { decision: { denied: { rejection: '用户拒绝了该操作。' } } };
    }
    return { decision: 'approved' };
  }
  if (optionId === 'allow_always') return { decision: 'acceptForSession' };
  if (optionId === 'reject_once') return { decision: 'decline' };
  return { decision: 'accept' };
}

function declineFor(kind: ApprovalKind): unknown {
  return kind === 'legacyExec' || kind === 'legacyPatch'
    ? { decision: 'abort' }
    : { decision: 'cancel' };
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const spawnImpl = options.spawnImpl ?? spawn;
  return {
    harnessId: 'codex',
    async probe(): Promise<ProbeResult> {
      return {
        harnessId: 'codex',
        version: null,
        auth: 'unknown',
        capabilities: {
          streaming: true,
          permissions: true,
          cancel: true,
          interrupt: false,
          resume: true,
          fork: false,
          mcp: true,
          usage: true,
        },
        limitations: [
          '权限策略固定为 on-request + workspace-write 沙箱，不使用 codex 配置中更宽松的设置。',
          '计划（plan）与协作代理等事件类型暂不展示。',
        ],
      };
    },
    async createSession(sessionOptions) {
      return createCodexSession(spawnImpl, sessionOptions, null);
    },
    async resumeSession(externalId, sessionOptions) {
      return createCodexSession(spawnImpl, sessionOptions, externalId);
    },
  };
}

async function createCodexSession(
  spawnImpl: typeof spawn,
  { cwd, executablePath, env }: CreateSessionOptions,
  resumeThreadId: string | null,
): Promise<AdapterSession> {
  if (!executablePath) throw new Error('未找到 codex 可执行文件，请先安装 Codex CLI。');

  const child = spawnImpl(executablePath, ['app-server'], {
    cwd,
    env,
    // Own process group so dispose() can reap tool subprocesses too.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const link = createStdioJsonRpc(child);

  try {
    await link.request('initialize', {
      clientInfo: { name: 'nexus', title: null, version: '0.0.0' },
      capabilities: null,
    });
    link.notify('initialized');
    const started = resumeThreadId
      ? await link.request('thread/resume', { threadId: resumeThreadId, excludeTurns: true })
      : await link.request('thread/start', {
          cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });
    const thread = (started as { thread?: { id?: string } }).thread;
    if (!thread?.id) throw new Error('codex 没有返回会话 id');
    return buildSession(link, thread.id);
  } catch (error) {
    // Best effort: the session never started, so the caller only needs the
    // group gone, not a verdict (the error below is the report).
    await link.stop();
    throw error;
  }
}

function buildSession(link: StdioJsonRpc, threadId: string): AdapterSession {
  let active: { runId: string; turnId: Promise<string> } | null = null;
  let disposed = false;
  const approvals = new Map<string, PendingApproval>();

  /** Decline every pending approval of a run (run ended or was cancelled). */
  const declineApprovals = (runId: string) => {
    for (const [requestId, pending] of [...approvals]) {
      if (pending.runId !== runId) continue;
      approvals.delete(requestId);
      link.respond(pending.requestWireId, declineFor(pending.kind));
    }
  };

  return {
    externalId: threadId,

    sendPrompt({ runId, text }) {
      if (disposed) throw new Error('Session is disposed');
      if (active) throw new Error('A run is already in progress for this session');

      const mapper = createRunMapper(runId);
      const queue = new AsyncQueue<AgentEvent>();
      queue.push({ type: 'run.started', runId });

      let offNotification = () => {};
      let offExit = () => {};
      let offServerRequest = () => {};
      let finished = false;
      const finish = (event: AgentEvent) => {
        if (finished) return;
        finished = true;
        declineApprovals(runId);
        if (active?.runId === runId) active = null;
        offNotification();
        offExit();
        offServerRequest();
        queue.push(event);
        queue.close();
      };

      offNotification = link.onNotification(({ method, params }) => {
        for (const event of mapper.handleNotification(method, params)) {
          if (event.type === 'run.completed' || event.type === 'run.failed') finish(event);
          else queue.push(event);
        }
      });
      offExit = link.onExit(() => {
        if (active?.runId !== runId) return;
        finish({
          type: 'run.failed',
          runId,
          error: {
            code: 'process_exited',
            message: `Codex 进程意外退出。${link.stderrTail().slice(-300)}`.trim(),
          },
        });
      });

      // Permission requests from the server become permission cards; the
      // user's choice is answered in respondToPermission below.
      offServerRequest = link.onServerRequest(({ id, method, params }) => {
        const p = (typeof params === 'object' && params !== null ? params : {}) as Record<
          string,
          unknown
        >;
        const requestId = `codex-${String(id)}`;
        const offer = (kind: ApprovalKind, description: string, toolCallId: string | null) => {
          approvals.set(requestId, {
            runId,
            kind,
            requestWireId: id,
            allowedOptions: new Set(PERMISSION_OPTIONS.map((o) => o.id)),
          });
          queue.push({
            type: 'permission.requested',
            runId,
            requestId,
            toolCallId,
            description,
            options: PERMISSION_OPTIONS,
          });
        };
        switch (method) {
          case 'item/commandExecution/requestApproval':
            offer(
              'commandExecution',
              typeof p.command === 'string' && p.command
                ? p.command
                : typeof p.reason === 'string' && p.reason
                  ? p.reason
                  : '执行命令',
              typeof p.itemId === 'string' ? p.itemId : null,
            );
            break;
          case 'item/fileChange/requestApproval':
            offer(
              'fileChange',
              typeof p.reason === 'string' && p.reason ? p.reason : '修改文件',
              typeof p.itemId === 'string' ? p.itemId : null,
            );
            break;
          case 'execCommandApproval': {
            const command = Array.isArray(p.command)
              ? p.command.join(' ')
              : String(p.command ?? '');
            offer('legacyExec', command || '执行命令', null);
            break;
          }
          case 'applyPatchApproval':
            offer('legacyPatch', '应用补丁', null);
            break;
          default:
            // Requests Nexus cannot render (elicitation, tool input, …) are
            // declined so the turn never hangs waiting for us.
            link.respondError(id, `Nexus 不支持该请求: ${method}`);
        }
      });

      const turnId = link
        .request('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
        })
        .then((result) => {
          const turn = (result as { turn?: { id?: string } }).turn;
          if (!turn?.id) throw new Error('codex 没有返回 turn id');
          return turn.id;
        });
      turnId.catch((error: Error) => {
        // The turn never started: no turn/completed will arrive, so finish here.
        finish({
          type: 'run.failed',
          runId,
          error: { code: 'turn_start_failed', message: error.message },
        });
      });
      active = { runId, turnId };

      return queue;
    },

    async cancel(runId) {
      if (active?.runId !== runId) return;
      declineApprovals(runId);
      const turn = await active.turnId.catch(() => null);
      if (turn) await link.request('turn/interrupt', { threadId, turnId: turn }).catch(() => {});
    },

    async respondToPermission(requestId, optionId) {
      const pending = approvals.get(requestId);
      if (!pending) throw new Error(`Unknown or expired permission request: ${requestId}`);
      if (!pending.allowedOptions.has(optionId)) {
        throw new Error(`Option ${optionId} was not offered for this request`);
      }
      approvals.delete(requestId);
      link.respond(pending.requestWireId, decisionFor(pending.kind, optionId));
    },

    async dispose() {
      disposed = true;
      if (active) declineApprovals(active.runId);
      return link.stop();
    },
  };
}
