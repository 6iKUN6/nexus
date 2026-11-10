import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AdapterSession,
  AgentAdapter,
  AgentEvent,
  CreateSessionOptions,
  ProbeResult,
} from '@nexus/protocol';
import { AsyncQueue } from './asyncQueue';

/**
 * pi adapter on `pi --mode rpc` (JSONL stdio; probed against the installed
 * pi, see probes/output/pi/rpc-*).
 *
 * One pi process per session; `--session-id` pins the project session id so a
 * restart re-attaches with the same id. pi has NO permission gating — tool
 * calls execute directly — so conversations must rely on worktree isolation
 * (the Nexus default for git repos). Extension UI requests
 * (`extension_ui_request`) are ignored: extensions are the user's setup, but
 * Nexus cannot render their dialogs.
 */

export type PiAdapterOptions = {
  /** Injected in tests. */
  spawnImpl?: typeof spawn;
};

const MAX_TEXT = 2000;

const truncate = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;

/** pi tool results are usually {content:[{type:'text',text}]}; be liberal. */
const summarizeResult = (result: unknown): string | null => {
  if (result == null) return null;
  if (typeof result === 'string') return truncate(result);
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
    if (text) return truncate(text);
  }
  return truncate(JSON.stringify(result));
};

type WireMessage = Record<string, unknown>;

export function createPiAdapter(options: PiAdapterOptions = {}): AgentAdapter {
  const spawnImpl = options.spawnImpl ?? spawn;
  return {
    harnessId: 'pi',
    async probe(): Promise<ProbeResult> {
      return {
        harnessId: 'pi',
        version: null,
        auth: 'unknown',
        capabilities: {
          streaming: true,
          permissions: false,
          cancel: true,
          interrupt: false,
          resume: true,
          fork: false,
          mcp: false,
          usage: true,
        },
        limitations: [
          '没有权限门控：命令和文件修改会直接执行，请始终在 worktree 隔离中使用。',
          '扩展（extensions）发出的界面请求会被忽略。',
        ],
      };
    },
    async createSession(sessionOptions) {
      return createPiSession(spawnImpl, sessionOptions, randomUUID());
    },
    async resumeSession(externalId, sessionOptions) {
      return createPiSession(spawnImpl, sessionOptions, externalId);
    },
  };
}

type PiProcess = {
  send(command: WireMessage): void;
  onMessage(listener: (msg: WireMessage) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  stderrTail(): string;
  kill(): void;
};

function startPiProcess(
  spawnImpl: typeof spawn,
  { cwd, executablePath, env }: CreateSessionOptions,
  sessionId: string,
): PiProcess {
  if (!executablePath) throw new Error('未找到 pi 可执行文件，请先安装 pi。');
  const child = spawnImpl(executablePath, ['--mode', 'rpc', '--session-id', sessionId], {
    cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const messages = new Set<(msg: WireMessage) => void>();
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  const stderrLines: string[] = [];

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as WireMessage;
        for (const listener of messages) listener(msg);
      } catch {
        stderrLines.push(`stdout: ${line.slice(0, 200)}`);
        if (stderrLines.length > 30) stderrLines.shift();
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > 30) stderrLines.shift();
    }
  });
  child.on('exit', (code, signal) => {
    for (const listener of exitListeners) listener(code, signal);
  });

  return {
    send(command) {
      child.stdin?.write(`${JSON.stringify(command)}\n`);
    },
    onMessage(listener) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    stderrTail: () => stderrLines.join('\n'),
    kill() {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 2000);
      timer.unref();
    },
  };
}

async function createPiSession(
  spawnImpl: typeof spawn,
  options: CreateSessionOptions,
  sessionId: string,
): Promise<AdapterSession> {
  const proc = startPiProcess(spawnImpl, options, sessionId);

  // Handshake: pi queues stdin commands from the start, so get_state doubles
  // as the readiness check (the user's extensions emit noise before it).
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('pi 启动超时。'));
    }, 15_000);
    const off = proc.onMessage((msg) => {
      if (msg.type === 'response' && msg.id === 'nexus-init') {
        clearTimeout(timer);
        off();
        if ((msg as { success?: unknown }).success === true) resolve();
        else reject(new Error(`pi 初始化失败: ${String((msg as { error?: unknown }).error)}`));
      }
    });
    proc.onExit((code) => {
      clearTimeout(timer);
      off();
      reject(new Error(`pi 启动后退出了（code ${code}）。${proc.stderrTail().slice(-300)}`.trim()));
    });
    proc.send({ id: 'nexus-init', type: 'get_state' });
  });

  let active: { runId: string } | null = null;
  let disposed = false;

  return {
    externalId: sessionId,

    sendPrompt({ runId, text }) {
      if (disposed) throw new Error('Session is disposed');
      if (active) throw new Error('A run is already in progress for this session');

      const queue = new AsyncQueue<AgentEvent>();
      queue.push({ type: 'run.started', runId });
      active = { runId };
      // The last assistant stopReason ('aborted' after cancel, 'error' on
      // provider failure) decides the terminal event.
      let lastStopReason: string | null = null;
      let lastErrorMessage: string | null = null;

      const finish = (event: AgentEvent) => {
        if (active?.runId === runId) active = null;
        offMessage();
        offExit();
        queue.push(event);
        queue.close();
      };

      const offMessage = proc.onMessage((msg) => {
        switch (msg.type) {
          case 'response': {
            // A rejected prompt means no agent events will follow.
            if (msg.command === 'prompt' && msg.success === false) {
              finish({
                type: 'run.failed',
                runId,
                error: { code: 'prompt_rejected', message: String(msg.error ?? 'pi 拒绝了输入。') },
              });
            }
            return;
          }
          case 'message_update': {
            const event = msg.assistantMessageEvent as { type?: string; delta?: unknown } | null;
            if (event?.type === 'text_delta' && typeof event.delta === 'string') {
              queue.push({ type: 'text.delta', runId, text: event.delta });
            } else if (event?.type === 'thinking_delta' && typeof event.delta === 'string') {
              queue.push({ type: 'thinking.delta', runId, text: event.delta });
            }
            return;
          }
          case 'tool_execution_start': {
            queue.push({
              type: 'tool.started',
              runId,
              toolCallId: String(msg.toolCallId ?? randomUUID()),
              name: String(msg.toolName ?? 'tool'),
              input: msg.args,
            });
            return;
          }
          case 'tool_execution_update':
            // Partial tool output is not rendered; the final result is enough.
            return;
          case 'tool_execution_end': {
            queue.push({
              type: 'tool.completed',
              runId,
              toolCallId: String(msg.toolCallId ?? ''),
              status: msg.isError === true ? 'error' : 'ok',
              summary: summarizeResult(msg.result),
            });
            return;
          }
          case 'turn_end': {
            const message = msg.message as
              | {
                  stopReason?: string;
                  errorMessage?: string;
                  usage?: { input?: number; output?: number };
                }
              | undefined;
            if (message?.stopReason) lastStopReason = message.stopReason;
            if (message?.errorMessage) lastErrorMessage = message.errorMessage;
            const usage = message?.usage;
            if (usage && (typeof usage.input === 'number' || typeof usage.output === 'number')) {
              queue.push({
                type: 'usage.updated',
                runId,
                inputTokens: typeof usage.input === 'number' ? usage.input : null,
                outputTokens: typeof usage.output === 'number' ? usage.output : null,
                estimated: false,
              });
            }
            return;
          }
          case 'agent_end': {
            if (lastStopReason === 'error') {
              finish({
                type: 'run.failed',
                runId,
                error: { code: 'model_error', message: lastErrorMessage ?? '模型调用失败。' },
              });
            } else {
              finish({
                type: 'run.completed',
                runId,
                stopReason: lastStopReason === 'aborted' ? 'cancelled' : 'end_turn',
              });
            }
            return;
          }
          default:
            // agent_start/turn_start/message_*, extension_*, auto_retry_*,
            // compaction_*, queue_update, entry_appended, …: no Nexus event.
            // agent_settled must NOT terminate a run: it belongs to the
            // previous agent loop and can arrive after the next prompt was
            // already sent (seen in the wild, would end the new run early).
            return;
        }
      });
      const offExit = proc.onExit(() => {
        if (active?.runId !== runId) return;
        finish({
          type: 'run.failed',
          runId,
          error: {
            code: 'process_exited',
            message: `pi 进程意外退出。${proc.stderrTail().slice(-300)}`.trim(),
          },
        });
      });

      proc.send({ id: runId, type: 'prompt', message: text });
      return queue;
    },

    async cancel(runId) {
      if (active?.runId !== runId) return;
      // pi does not answer the abort command; agent_end arrives with
      // stopReason 'aborted' and ends the run.
      proc.send({ id: `abort-${runId}`, type: 'abort' });
    },

    async dispose() {
      disposed = true;
      proc.kill();
    },
  };
}
