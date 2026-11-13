import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { type CollaborationTool, collaborationMethod, collaborationTools } from '@nexus/protocol';
import type { SessionTokens } from './tokens';

/**
 * The local collaboration socket (D14, ADR 0016). NDJSON JSON-RPC 2.0 over a
 * unix socket in the user's data directory, mode 0600. The first request on a
 * connection must authenticate with a per-session token; afterwards the
 * connection is bound to that conversation.
 *
 * This is deliberately NOT the main RPC: the main port is handed to renderers,
 * while this one is reachable by anything running as the user. Token scoping
 * and relationship checks (in the service layer) are what keep it narrow.
 */

export type CollabHandler = (conversationId: string, params: unknown) => Promise<unknown>;

export type CollaborationServerDeps = {
  socketPath: string;
  tokens: SessionTokens;
  handlers: Record<CollaborationTool, CollabHandler>;
  /** Sliding window per conversation; protects against agent message loops. */
  maxCallsPerMinute?: number;
  now?: () => number;
};

type RpcEnvelope = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const ErrorCodes = {
  Unauthorized: -32001,
  RateLimited: -32003,
  InvalidParams: -32602,
  MethodNotFound: -32601,
  Internal: -32603,
} as const;

export function startCollaborationServer(deps: CollaborationServerDeps): {
  /** Resolves once listening (or once binding failed and was logged). */
  ready: Promise<void>;
  close(): Promise<void>;
} {
  const now = deps.now ?? Date.now;
  const maxCalls = deps.maxCallsPerMinute ?? 30;
  const callsByConversation = new Map<string, number[]>();
  const sockets = new Set<Socket>();

  rmSync(deps.socketPath, { force: true });
  mkdirSync(dirname(deps.socketPath), { recursive: true });

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let conversationId: string | null = null;
    let buffer = '';

    const reply = (id: unknown, body: Record<string, unknown>) => {
      if (id === undefined) return; // notification: no reply
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
    };
    const fail = (id: unknown, code: number, message: string) =>
      reply(id, { error: { code, message } });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let message: RpcEnvelope;
        try {
          message = JSON.parse(line) as RpcEnvelope;
        } catch {
          fail(null, ErrorCodes.InvalidParams, '请求不是合法的 JSON');
          continue;
        }
        void handle(
          message,
          reply,
          fail,
          () => conversationId,
          (id) => {
            conversationId = id;
          },
        );
      }
    });
    socket.on('error', () => socket.destroy());

    async function handle(
      message: RpcEnvelope,
      reply: (id: unknown, body: Record<string, unknown>) => void,
      fail: (id: unknown, code: number, message: string) => void,
      current: () => string | null,
      authenticate: (conversationId: string) => void,
    ) {
      const { id, method, params } = message;
      if (method === 'auth') {
        const token =
          typeof params === 'object' && params !== null && 'token' in params
            ? (params as { token: unknown }).token
            : undefined;
        const conversation = typeof token === 'string' ? deps.tokens.resolve(token) : null;
        if (!conversation) {
          fail(id, ErrorCodes.Unauthorized, '会话令牌无效或已过期');
          return;
        }
        authenticate(conversation);
        reply(id, { result: { ok: true } });
        return;
      }

      const authed = current();
      if (!authed) {
        fail(id, ErrorCodes.Unauthorized, '请先发送 auth 请求');
        return;
      }

      const tool = Object.keys(collaborationTools).find(
        (name) => collaborationMethod(name as CollaborationTool) === method,
      ) as CollaborationTool | undefined;
      if (!tool) {
        fail(id, ErrorCodes.MethodNotFound, `未知方法：${String(method)}`);
        return;
      }

      const definition = collaborationTools[tool];
      const parsed = definition.params.safeParse(params ?? {});
      if (!parsed.success) {
        fail(id, ErrorCodes.InvalidParams, `参数不合法：${parsed.error.message}`);
        return;
      }

      // Sliding-window rate limit per conversation.
      const recent = (callsByConversation.get(authed) ?? []).filter((at) => now() - at < 60_000);
      if (recent.length >= maxCalls) {
        fail(id, ErrorCodes.RateLimited, '调用过于频繁，请稍后再试');
        return;
      }
      recent.push(now());
      callsByConversation.set(authed, recent);

      try {
        const result = await deps.handlers[tool](authed, parsed.data);
        const checked = definition.result.safeParse(result);
        if (!checked.success) {
          fail(id, ErrorCodes.Internal, 'core 返回了不合法结果');
          return;
        }
        reply(id, { result: checked.data });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code: unknown }).code
            : undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (typeof code === 'number') {
          fail(id, code, message);
        } else {
          fail(id, ErrorCodes.Internal, message);
        }
      }
    }
  });

  let settleReady = () => {};
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  server.on('error', (error) => {
    // A missing socket must not take the whole app down: collaboration is an
    // enhancement, and adapters simply find no reachable channel.
    console.error('nexus: collaboration socket failed', error);
    settleReady();
  });
  server.listen(deps.socketPath, () => {
    try {
      chmodSync(deps.socketPath, 0o600);
    } catch {
      // Best effort: the socket lives in the user's own data directory anyway.
    }
    settleReady();
  });

  return {
    ready,
    async close() {
      await ready;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(deps.socketPath, { force: true });
    },
  };
}
