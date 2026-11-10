import { randomUUID } from 'node:crypto';
import {
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AdapterSession,
  AgentAdapter,
  AgentEvent,
  CreateSessionOptions,
  PermissionOption,
  ProbeResult,
} from '@nexus/protocol';
import { AsyncQueue } from './asyncQueue';
import { createMapperState, mapSdkMessage, summarizeToolInput } from './mapMessages';

/**
 * Claude Code adapter on the Claude Agent SDK (probe conclusion: headless
 * `claude -p` cannot route permission prompts to a host; the SDK's
 * `canUseTool` can).
 *
 * One `query()` per prompt: the first uses a preset `sessionId`, later ones
 * `resume` it, so the session survives app restarts. The SDK drives the
 * user's own `claude` executable (core passes the detected path), so their
 * login, settings and CLAUDE.md apply.
 */

type QueryFn = typeof query;

export type ClaudeAdapterOptions = {
  /** Injected in tests. */
  queryImpl?: QueryFn;
};

const PERMISSION_OPTIONS = {
  allowOnce: { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
  allowAlways: { id: 'allow_always', label: '本会话始终允许', kind: 'allow_always' },
  reject: { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
} as const satisfies Record<string, PermissionOption>;

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const queryImpl = options.queryImpl ?? query;
  return {
    harnessId: 'claude-code',
    async probe(): Promise<ProbeResult> {
      return {
        harnessId: 'claude-code',
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
        limitations: ['子代理（Task 工具）内部只显示工具调用，其正文不并入主时间线。'],
      };
    },
    async createSession(sessionOptions) {
      return createClaudeSession(queryImpl, randomUUID(), false, sessionOptions);
    },
    async resumeSession(externalId, sessionOptions) {
      return createClaudeSession(queryImpl, externalId, true, sessionOptions);
    },
  };
}

type PendingPermission = {
  runId: string;
  suggestions: PermissionUpdate[] | undefined;
  allowedOptions: Set<string>;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
};

function createClaudeSession(
  queryImpl: QueryFn,
  externalId: string,
  existing: boolean,
  { cwd, executablePath, env }: CreateSessionOptions,
): AdapterSession {
  let hasHistory = existing;
  let active: { runId: string; abort: AbortController } | null = null;
  const permissions = new Map<string, PendingPermission>();
  let disposed = false;

  function denyAllFor(runId: string, message: string) {
    for (const [requestId, pending] of permissions) {
      if (pending.runId !== runId) continue;
      permissions.delete(requestId);
      pending.resolve({ behavior: 'deny', message });
    }
  }

  return {
    externalId,

    sendPrompt({ runId, text }) {
      if (disposed) throw new Error('Session is disposed');
      if (active) throw new Error('A run is already in progress for this session');

      const queue = new AsyncQueue<AgentEvent>();
      const abort = new AbortController();
      active = { runId, abort };
      const state = createMapperState(runId);
      const stderrTail: string[] = [];

      const canUseTool: CanUseTool = (toolName, input, context) =>
        new Promise<PermissionResult>((resolve) => {
          const requestId = randomUUID();
          const offerAlways =
            Boolean(context.suggestions?.length) && !context.suppressAlwaysAllowRule;
          const offered: PermissionOption[] = [
            PERMISSION_OPTIONS.allowOnce,
            ...(offerAlways ? [PERMISSION_OPTIONS.allowAlways] : []),
            PERMISSION_OPTIONS.reject,
          ];
          permissions.set(requestId, {
            runId,
            suggestions: context.suggestions,
            allowedOptions: new Set(offered.map((o) => o.id)),
            input,
            resolve,
          });
          context.signal.addEventListener(
            'abort',
            () => {
              if (permissions.delete(requestId)) {
                resolve({ behavior: 'deny', message: 'Run was cancelled.' });
              }
            },
            { once: true },
          );
          const target = summarizeToolInput(input);
          queue.push({
            type: 'permission.requested',
            runId,
            requestId,
            toolCallId: context.toolUseID,
            description:
              context.title ??
              `${context.displayName ?? toolName}${target ? ` · ${JSON.stringify(target)}` : ''}`,
            options: offered,
          });
        });

      const sdkOptions: Options = {
        cwd,
        env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'nexus/0.0' },
        abortController: abort,
        includePartialMessages: true,
        // Manual approvals through canUseTool, regardless of the user's defaultMode.
        permissionMode: 'default',
        canUseTool,
        stderr: (chunk) => {
          stderrTail.push(chunk);
          if (stderrTail.length > 20) stderrTail.shift();
        },
        ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
        ...(hasHistory ? { resume: externalId } : { sessionId: externalId }),
      };

      const finish = (event: AgentEvent | null) => {
        if (event && !state.terminal) {
          state.terminal = true;
          queue.push(event);
        }
        denyAllFor(runId, 'Run ended.');
        if (active?.runId === runId) active = null;
        queue.close();
      };

      void (async () => {
        queue.push({ type: 'run.started', runId });
        if (!executablePath) {
          finish({
            type: 'run.failed',
            runId,
            error: {
              code: 'not_installed',
              message: '未找到 claude 可执行文件，请先安装 Claude Code。',
            },
          });
          return;
        }
        try {
          for await (const message of queryImpl({ prompt: text, options: sdkOptions })) {
            // The session file exists once the CLI has started this turn.
            hasHistory = true;
            for (const event of mapSdkMessage(message, state)) queue.push(event);
          }
          finish(
            abort.signal.aborted
              ? { type: 'run.completed', runId, stopReason: 'cancelled' }
              : {
                  type: 'run.failed',
                  runId,
                  error: { code: 'no_result', message: 'Claude Code 未返回结果就结束了。' },
                },
          );
        } catch (error) {
          if (abort.signal.aborted) {
            finish({ type: 'run.completed', runId, stopReason: 'cancelled' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          const stderr = stderrTail.join('').trim().slice(-600);
          // The SDK often embeds stderr in its own message already; don't repeat it.
          const withStderr =
            stderr && !message.includes(stderr.slice(0, 60)) ? `${message}\n${stderr}` : message;
          finish({
            type: 'run.failed',
            runId,
            error: { code: 'process_error', message: withStderr },
          });
        }
      })();

      return queue;
    },

    async cancel(runId) {
      if (active?.runId !== runId) return;
      denyAllFor(runId, 'Run was cancelled.');
      active.abort.abort();
    },

    async respondToPermission(requestId, optionId) {
      const pending = permissions.get(requestId);
      if (!pending) throw new Error(`Unknown or expired permission request: ${requestId}`);
      if (!pending.allowedOptions.has(optionId)) {
        throw new Error(`Option ${optionId} was not offered for this request`);
      }
      permissions.delete(requestId);
      if (optionId === PERMISSION_OPTIONS.reject.id) {
        pending.resolve({ behavior: 'deny', message: 'The user rejected this action.' });
      } else if (optionId === PERMISSION_OPTIONS.allowAlways.id && pending.suggestions) {
        pending.resolve({
          behavior: 'allow',
          updatedInput: pending.input,
          updatedPermissions: pending.suggestions,
        });
      } else {
        pending.resolve({ behavior: 'allow', updatedInput: pending.input });
      }
    },

    async dispose() {
      disposed = true;
      if (active) {
        denyAllFor(active.runId, 'Session closed.');
        active.abort.abort();
      }
      // The SDK owns the CLI subprocess (it spawns one per query and closes it
      // on abort, with its own stdin-EOF → SIGTERM → SIGKILL path). There is no
      // handle for us to poll, so a stopped query is reported as confirmed; an
      // idle session has no process at all.
      return { confirmed: true, problem: null };
    },
  };
}
