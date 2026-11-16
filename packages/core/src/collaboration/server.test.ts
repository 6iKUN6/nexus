import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollaborationTool } from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type CollabHandler, startCollaborationServer } from './server';
import { SessionTokens } from './tokens';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

type Reply = { id?: unknown; result?: unknown; error?: { code: number; message: string } };

function client(socketPath: string) {
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  let buffer = '';
  const waiters: Array<(reply: Reply) => void> = [];
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(JSON.parse(line) as Reply);
    }
  });
  return {
    send(message: Record<string, unknown>) {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    },
    next(): Promise<Reply> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket reply timeout')), 2000);
        waiters.push((reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
      });
    },
    close() {
      socket.destroy();
    },
  };
}

function setup(handlers?: Partial<Record<CollaborationTool, CollabHandler>>, maxCalls?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-collab-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'nexus.sock');
  const tokens = new SessionTokens();
  const token = tokens.issue('conversation-1');
  const calls: Array<{ tool: CollaborationTool; conversationId: string; params: unknown }> = [];
  const defaults: Record<CollaborationTool, CollabHandler> = {
    read_task_context: async () => ({
      role: 'child',
      taskId: 'task-1',
      goal: '整理笔记',
      acceptance: null,
      status: 'running',
    }),
    send_message: async (conversationId, params) => {
      calls.push({ tool: 'send_message', conversationId, params });
      return { messageId: 'message-1', state: 'delivered' };
    },
    delegate: async () => ({ taskId: 'task-2', conversationId: 'conversation-2' }),
    report_result: async () => ({ taskId: 'task-1', status: 'review' }),
    request_handoff: async () => ({ recorded: true }),
    open_preview: async () => ({ recorded: true }),
  };
  const server = startCollaborationServer({
    socketPath,
    tokens,
    handlers: { ...defaults, ...handlers },
    ...(maxCalls === undefined ? {} : { maxCallsPerMinute: maxCalls }),
  });
  cleanups.push(async () => {
    await server.close();
  });
  return { server, socketPath, token, calls };
}

describe('collaboration server', () => {
  it('requires an auth handshake and rejects unknown tokens', async () => {
    const { server, socketPath, token } = setup();
    await server.ready;

    const connection = client(socketPath);
    cleanups.push(() => connection.close());

    connection.send({ id: 1, method: 'collab.read_task_context', params: {} });
    expect((await connection.next()).error?.code).toBe(-32001);

    connection.send({ id: 2, method: 'auth', params: { token: 'not-a-token' } });
    expect((await connection.next()).error?.code).toBe(-32001);

    connection.send({ id: 3, method: 'auth', params: { token } });
    expect((await connection.next()).result).toEqual({ ok: true });
  });

  it('dispatches tools with validated params and a validated result', async () => {
    const { server, socketPath, token, calls } = setup();
    await server.ready;
    const connection = client(socketPath);
    cleanups.push(() => connection.close());

    connection.send({ id: 1, method: 'auth', params: { token } });
    await connection.next();

    connection.send({
      id: 2,
      method: 'collab.send_message',
      params: { text: '父会话，我卡在登录跳转了' },
    });
    expect((await connection.next()).result).toEqual({
      messageId: 'message-1',
      state: 'delivered',
    });
    expect(calls).toEqual([
      {
        tool: 'send_message',
        conversationId: 'conversation-1',
        params: { text: '父会话，我卡在登录跳转了', to: 'parent' },
      },
    ]);

    connection.send({ id: 3, method: 'collab.send_message', params: {} });
    expect((await connection.next()).error?.code).toBe(-32602);

    connection.send({ id: 4, method: 'collab.nope', params: {} });
    expect((await connection.next()).error?.code).toBe(-32601);
  });

  it('reports a handler result that does not match the tool schema', async () => {
    const { server, socketPath, token } = setup({
      read_task_context: async () => ({ role: 'something-else' }) as never,
    });
    await server.ready;
    const connection = client(socketPath);
    cleanups.push(() => connection.close());

    connection.send({ id: 1, method: 'auth', params: { token } });
    await connection.next();
    connection.send({ id: 2, method: 'collab.read_task_context', params: {} });
    expect((await connection.next()).error?.code).toBe(-32603);
  });

  it('rate limits a conversation that calls in a loop', async () => {
    const { server, socketPath, token } = setup(undefined, 2);
    await server.ready;
    const connection = client(socketPath);
    cleanups.push(() => connection.close());

    connection.send({ id: 1, method: 'auth', params: { token } });
    await connection.next();

    connection.send({ id: 2, method: 'collab.read_task_context', params: {} });
    expect((await connection.next()).result).toBeTruthy();
    connection.send({ id: 3, method: 'collab.read_task_context', params: {} });
    expect((await connection.next()).result).toBeTruthy();
    connection.send({ id: 4, method: 'collab.read_task_context', params: {} });
    expect((await connection.next()).error?.code).toBe(-32003);
  });

  it('creates the socket with owner-only permissions', async () => {
    const { server, socketPath } = setup();
    await server.ready;
    if (process.platform !== 'win32') {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    }
  });
});
