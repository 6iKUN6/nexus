import { randomUUID } from 'node:crypto';
import type {
  AdapterSession,
  AgentAdapter,
  AgentEvent,
  PermissionOption,
  ProbeResult,
} from '@nexus/protocol';

/**
 * Scripted adapter used by tests and UI development. It behaves like a real
 * harness at the contract level: streaming, tool calls, permission prompts
 * that block until answered, failures and cancellation.
 */

export type FakeToolChild = {
  name: string;
  input?: unknown;
  status?: 'ok' | 'error';
  summary?: string;
};

export type FakeStep =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      name: string;
      input?: unknown;
      status?: 'ok' | 'error';
      summary?: string;
      /** Nested calls, like a Task tool's sub-agent trace. */
      children?: FakeToolChild[];
    }
  | { kind: 'permission'; description: string }
  | { kind: 'fail'; code: string; message: string };

export type FakeAdapterOptions = {
  /** Steps to play for every prompt. Defaults to echoing the prompt in chunks. */
  script?: FakeStep[] | ((prompt: string) => FakeStep[]);
  /** Delay before each step, in ms. Defaults to 0. */
  stepDelayMs?: number;
};

export const FAKE_PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'allow', label: '允许', kind: 'allow_once' },
  { id: 'reject', label: '拒绝', kind: 'reject_once' },
];

export function echoScript(prompt: string): FakeStep[] {
  const chunks = prompt.match(/.{1,8}/gsu) ?? [];
  return [
    { kind: 'text', text: '收到：' },
    ...chunks.map((text) => ({ kind: 'text' as const, text })),
  ];
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): AgentAdapter {
  const script = options.script ?? echoScript;
  const stepsFor = (prompt: string) => (typeof script === 'function' ? script(prompt) : script);
  const stepDelayMs = options.stepDelayMs ?? 0;

  return {
    harnessId: 'fake',
    async probe(): Promise<ProbeResult> {
      return {
        harnessId: 'fake',
        version: '0.0.0',
        auth: 'authenticated',
        capabilities: {
          streaming: true,
          permissions: true,
          cancel: true,
          interrupt: false,
          resume: false,
          fork: false,
          mcp: false,
          usage: false,
        },
        limitations: ['Scripted responses only.'],
      };
    },
    async createSession() {
      return createFakeSession(stepsFor, stepDelayMs);
    },
  };
}

type PendingPermission = {
  runId: string;
  resolve: (optionId: string | null) => void;
};

function createFakeSession(
  stepsFor: (prompt: string) => FakeStep[],
  stepDelayMs: number,
): AdapterSession {
  const runs = new Map<string, AbortController>();
  const permissions = new Map<string, PendingPermission>();
  let disposed = false;

  const waitForPermission = (requestId: string, runId: string, signal: AbortSignal) =>
    new Promise<string | null>((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const onAbort = () => {
        permissions.delete(requestId);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      permissions.set(requestId, {
        runId,
        resolve: (optionId) => {
          signal.removeEventListener('abort', onAbort);
          resolve(optionId);
        },
      });
    });

  async function* play(
    runId: string,
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    yield { type: 'run.started', runId };
    let toolIndex = 0;
    for (const step of stepsFor(prompt)) {
      await sleep(stepDelayMs, signal);
      if (signal.aborted) break;

      switch (step.kind) {
        case 'text':
          yield { type: 'text.delta', runId, text: step.text };
          break;
        case 'thinking':
          yield { type: 'thinking.delta', runId, text: step.text };
          break;
        case 'tool': {
          const toolCallId = `${runId}-tool-${toolIndex++}`;
          yield {
            type: 'tool.started',
            runId,
            toolCallId,
            name: step.name,
            input: step.input ?? null,
          };
          for (const child of step.children ?? []) {
            await sleep(stepDelayMs, signal);
            if (signal.aborted) break;
            const childId = `${runId}-tool-${toolIndex++}`;
            yield {
              type: 'tool.started',
              runId,
              toolCallId: childId,
              name: child.name,
              input: child.input ?? null,
              parentToolCallId: toolCallId,
            };
            yield {
              type: 'tool.completed',
              runId,
              toolCallId: childId,
              status: child.status ?? 'ok',
              summary: child.summary ?? null,
            };
          }
          yield {
            type: 'tool.completed',
            runId,
            toolCallId,
            status: step.status ?? 'ok',
            summary: step.summary ?? null,
          };
          break;
        }
        case 'permission': {
          const requestId = randomUUID();
          // Register before yielding: consumers usually answer from inside the
          // for-await body, while this generator is still suspended at the yield.
          const decision = waitForPermission(requestId, runId, signal);
          yield {
            type: 'permission.requested',
            runId,
            requestId,
            toolCallId: null,
            description: step.description,
            options: FAKE_PERMISSION_OPTIONS,
          };
          const choice = await decision;
          if (choice === 'reject') {
            yield { type: 'run.completed', runId, stopReason: 'refused' };
            return;
          }
          break;
        }
        case 'fail':
          yield { type: 'run.failed', runId, error: { code: step.code, message: step.message } };
          return;
      }
    }
    yield { type: 'run.completed', runId, stopReason: signal.aborted ? 'cancelled' : 'end_turn' };
  }

  return {
    externalId: `fake-${randomUUID()}`,

    async *sendPrompt({ runId, text }) {
      if (disposed) throw new Error('Session is disposed');
      if (runs.size > 0) throw new Error('A run is already in progress for this session');
      const controller = new AbortController();
      runs.set(runId, controller);
      try {
        yield* play(runId, text, controller.signal);
      } finally {
        runs.delete(runId);
      }
    },

    async cancel(runId) {
      runs.get(runId)?.abort();
    },

    async respondToPermission(requestId, optionId) {
      const pending = permissions.get(requestId);
      if (!pending) throw new Error(`Unknown or expired permission request: ${requestId}`);
      if (!FAKE_PERMISSION_OPTIONS.some((option) => option.id === optionId)) {
        throw new Error(`Unknown permission option: ${optionId}`);
      }
      permissions.delete(requestId);
      pending.resolve(optionId);
    },

    async dispose() {
      disposed = true;
      for (const controller of runs.values()) controller.abort();
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
