import type { ChildProcess } from 'node:child_process';

/**
 * Minimal JSON-RPC 2.0 client over a child process's stdio (one message per
 * line), as spoken by `codex app-server`. Handles three message kinds:
 * responses to our requests, server notifications, and server-initiated
 * requests (approvals) that we must answer.
 *
 * Wire types are hand-written here on purpose: the generated reference
 * bindings live in probes/output (gitignored), and the adapter only needs the
 * subset below.
 */

export type JsonRpcServerRequest = {
  id: number | string;
  method: string;
  params: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params: unknown;
};

export type StdioJsonRpc = {
  /** Rejects on a JSON-RPC error response or when the process exits first. */
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): void;
  /** Answer a server-initiated request with a result. */
  respond(id: number | string, result: unknown): void;
  /** Answer a server-initiated request with a JSON-RPC error (we decline it). */
  respondError(id: number | string, message: string): void;
  onNotification(listener: (msg: JsonRpcNotification) => void): () => void;
  onServerRequest(listener: (req: JsonRpcServerRequest) => void): () => void;
  /** Fires once when the process exits; pending requests reject. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  /** Last stderr lines, for error diagnostics. */
  stderrTail(): string;
  /** SIGTERM the process group, then SIGKILL after a grace period. */
  kill(): void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export function createStdioJsonRpc(child: ChildProcess): StdioJsonRpc {
  let buffer = '';
  let nextId = 1;
  let exited = false;
  const pending = new Map<number, Pending>();
  const notifications = new Set<(msg: JsonRpcNotification) => void>();
  const serverRequests = new Set<(req: JsonRpcServerRequest) => void>();
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  const stderrLines: string[] = [];

  const failPending = (message: string) => {
    for (const [, entry] of pending) entry.reject(new Error(message));
    pending.clear();
  };

  const dispatch = (msg: Record<string, unknown>) => {
    // Response to one of our requests: numeric id we issued, no method.
    if (msg.method === undefined && typeof msg.id === 'number') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error !== undefined && msg.error !== null) {
        const err = msg.error as { message?: unknown };
        entry.reject(new Error(typeof err.message === 'string' ? err.message : 'JSON-RPC error'));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method !== 'string') return;
    // Server-initiated request (approvals) — it has an id and expects an answer.
    if (typeof msg.id === 'number' || typeof msg.id === 'string') {
      const req: JsonRpcServerRequest = { id: msg.id, method: msg.method, params: msg.params };
      for (const listener of serverRequests) listener(req);
      return;
    }
    for (const listener of notifications) {
      listener({ method: msg.method, params: msg.params });
    }
  };

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
        dispatch(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Non-JSON stdout noise is kept for diagnostics, never trusted.
        stderrLines.push(`stdout: ${line.slice(0, 200)}`);
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
    exited = true;
    failPending(`codex app-server exited (code ${code}, signal ${signal})`);
    for (const listener of exitListeners) listener(code, signal);
  });

  return {
    request(method, params) {
      if (exited) return Promise.reject(new Error('codex app-server is not running'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    respond(id, result) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    },
    respondError(id, message) {
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`,
      );
    },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onServerRequest(listener) {
      serverRequests.add(listener);
      return () => serverRequests.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    stderrTail: () => stderrLines.join('\n'),
    kill() {
      // The app-server owns tool subprocesses; kill the whole group (spawned
      // detached) so nothing outlives the session.
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
