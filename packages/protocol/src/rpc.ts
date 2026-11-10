import { z } from 'zod';
import { conversationEventSchema, conversationSchema, isolationSchema } from './conversation';
import { harnessIdSchema, harnessInfoSchema } from './harness';

/**
 * Minimal typed JSON-RPC 2.0 over any message port (Electron MessagePort,
 * WebSocket, in-memory pair). Every request, result and notification is
 * validated against the schemas below, on both ends.
 *
 * Requests go client → server. Notifications go server → client only
 * (core pushing events); they carry no id and get no reply.
 */

export type RpcPort = {
  send(message: unknown): void;
  /** Subscribes to incoming messages; returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
};

export const rpcMethods = {
  'system.ping': {
    params: z.object({}),
    result: z.object({ coreVersion: z.string(), uptimeMs: z.number().nonnegative() }),
  },
  'harness.list': {
    params: z.object({ refresh: z.boolean().default(false) }),
    result: z.object({ harnesses: z.array(harnessInfoSchema) }),
  },
  'conversation.list': {
    params: z.object({}),
    result: z.object({ conversations: z.array(conversationSchema) }),
  },
  'conversation.create': {
    params: z.object({
      harnessId: harnessIdSchema,
      cwd: z.string().min(1),
      /** Defaults to direct for backwards compatibility; the UI always sends it. */
      isolation: isolationSchema.default('direct'),
      title: z.string().trim().min(1).max(120).optional(),
    }),
    result: z.object({ conversation: conversationSchema }),
  },
  /** Inspects a working directory for the new-conversation dialog (ADR 0006). */
  'path.inspect': {
    params: z.object({ cwd: z.string().min(1) }),
    result: z.object({
      exists: z.boolean(),
      isGitRepo: z.boolean(),
      repoRoot: z.string().nullable(),
      /** True when another conversation already runs directly in this directory. */
      directInUse: z.boolean(),
    }),
  },
  /** History with seq > afterSeq, in order. Used on open and to fill gaps after reconnect. */
  'conversation.events': {
    params: z.object({
      conversationId: z.string(),
      afterSeq: z.number().int().nonnegative().default(0),
    }),
    result: z.object({ events: z.array(conversationEventSchema) }),
  },
  /** Sends a prompt; if a run is active it is queued and runs afterwards. */
  'conversation.send': {
    params: z.object({ conversationId: z.string(), text: z.string().trim().min(1) }),
    result: z.object({ messageId: z.string(), runId: z.string(), queued: z.boolean() }),
  },
  /** Cancels the active run (queued prompts stay queued). */
  'conversation.cancel': {
    params: z.object({ conversationId: z.string() }),
    result: z.object({ cancelled: z.boolean() }),
  },
  'permission.respond': {
    params: z.object({ conversationId: z.string(), requestId: z.string(), optionId: z.string() }),
    result: z.object({}),
  },
} satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export const rpcNotifications = {
  'conversation.event': conversationEventSchema,
  /** Conversation metadata changed (state, preview, title, session id). */
  'conversation.updated': conversationSchema,
} satisfies Record<string, z.ZodType>;

export type RpcNotification = keyof typeof rpcNotifications;
export type RpcNotificationParams<N extends RpcNotification> = z.output<
  (typeof rpcNotifications)[N]
>;

export type RpcMethod = keyof typeof rpcMethods;
/** What a caller passes (defaults may be omitted). */
export type RpcParams<M extends RpcMethod> = z.input<(typeof rpcMethods)[M]['params']>;
/** What a handler receives (defaults applied). */
export type RpcHandlerParams<M extends RpcMethod> = z.output<(typeof rpcMethods)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcMethods)[M]['result']>;

export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcHandlerParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;
};

export const RpcErrorCode = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Timeout: -32000,
  Closed: -32001,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

const requestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().int(),
  method: z.string(),
  params: z.unknown(),
});

const errorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().int().nullable(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }),
});

const notificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown(),
});

const successResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().int(),
  result: z.unknown(),
});

function isRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(rpcMethods, method);
}

function errorResponse(id: number | null, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** Sends a validated server → client notification. Throws if params violate the schema. */
export function sendNotification<N extends RpcNotification>(
  port: RpcPort,
  method: N,
  params: RpcNotificationParams<N>,
): void {
  const parsed = rpcNotifications[method].parse(params);
  port.send({ jsonrpc: '2.0', method, params: parsed });
}

/** Serves `handlers` on `port`. Returns a function that stops serving. */
export function serveRpc(port: RpcPort, handlers: RpcHandlers): () => void {
  return port.onMessage((raw) => {
    void handleRequest(port, handlers, raw);
  });
}

async function handleRequest(port: RpcPort, handlers: RpcHandlers, raw: unknown): Promise<void> {
  const request = requestSchema.safeParse(raw);
  if (!request.success) {
    port.send(errorResponse(null, RpcErrorCode.InvalidRequest, 'Invalid JSON-RPC request'));
    return;
  }
  const { id, method, params } = request.data;
  if (!isRpcMethod(method)) {
    port.send(errorResponse(id, RpcErrorCode.MethodNotFound, `Unknown method: ${method}`));
    return;
  }

  const definition = rpcMethods[method];
  const parsedParams = definition.params.safeParse(params ?? {});
  if (!parsedParams.success) {
    port.send(
      errorResponse(id, RpcErrorCode.InvalidParams, `Invalid params for ${method}`, {
        issues: parsedParams.error.issues,
      }),
    );
    return;
  }

  try {
    // The mapped handler type cannot be narrowed by `method` here; params were validated above.
    const handler = handlers[method] as (params: unknown) => unknown;
    const result = definition.result.safeParse(await handler(parsedParams.data));
    if (!result.success) {
      port.send(
        errorResponse(
          id,
          RpcErrorCode.Internal,
          `Handler for ${method} returned an invalid result`,
        ),
      );
      return;
    }
    port.send({ jsonrpc: '2.0', id, result: result.data });
  } catch (error) {
    if (error instanceof RpcError) {
      port.send(errorResponse(id, error.code, error.message, error.data));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    port.send(errorResponse(id, RpcErrorCode.Internal, message));
  }
}

export type RpcClient = {
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** Subscribes to a server notification; returns an unsubscribe function. */
  onNotification<N extends RpcNotification>(
    method: N,
    listener: (params: RpcNotificationParams<N>) => void,
  ): () => void;
  /** Rejects all pending requests and stops listening. */
  close(): void;
};

type PendingRequest = {
  method: RpcMethod;
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createRpcClient(port: RpcPort, options: { timeoutMs?: number } = {}): RpcClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pending = new Map<number, PendingRequest>();
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  let nextId = 1;
  let closed = false;

  const settle = (id: number): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      clearTimeout(entry.timer);
    }
    return entry;
  };

  const unsubscribe = port.onMessage((raw) => {
    if (raw && typeof raw === 'object' && !('id' in raw)) {
      const notification = notificationSchema.safeParse(raw);
      if (!notification.success) return;
      const { method, params } = notification.data;
      if (!Object.hasOwn(rpcNotifications, method)) return;
      const parsed = rpcNotifications[method as RpcNotification].safeParse(params);
      if (!parsed.success) {
        console.error(`[rpc] dropped invalid ${method} notification`, parsed.error.issues);
        return;
      }
      for (const listener of listeners.get(method) ?? []) listener(parsed.data);
      return;
    }
    const failure = errorResponseSchema.safeParse(raw);
    if (failure.success) {
      if (failure.data.id === null) return;
      const { code, message, data } = failure.data.error;
      settle(failure.data.id)?.reject(new RpcError(code, message, data));
      return;
    }
    const success = successResponseSchema.safeParse(raw);
    if (!success.success) return;
    const entry = settle(success.data.id);
    if (!entry) return;
    const result = rpcMethods[entry.method].result.safeParse(success.data.result);
    if (result.success) {
      entry.resolve(result.data);
    } else {
      entry.reject(new RpcError(RpcErrorCode.Internal, `Invalid result for ${entry.method}`));
    }
  });

  return {
    request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      if (closed) {
        return Promise.reject(new RpcError(RpcErrorCode.Closed, 'RPC client is closed'));
      }
      const id = nextId++;
      return new Promise<RpcResult<M>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new RpcError(RpcErrorCode.Timeout, `${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        pending.set(id, {
          method,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        port.send({ jsonrpc: '2.0', id, method, params });
      });
    },
    onNotification(method, listener) {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set);
      const entry = listener as (params: unknown) => void;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      listeners.clear();
      for (const id of [...pending.keys()]) {
        settle(id)?.reject(new RpcError(RpcErrorCode.Closed, 'RPC client is closed'));
      }
    },
  };
}
