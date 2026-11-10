import { describe, expect, it } from 'vitest';
import { createMemoryPortPair } from './memoryPort';
import {
  createRpcClient,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
  sendNotification,
  serveRpc,
} from './rpc';

const unused = () => {
  throw new Error('not used in this test');
};

const okHandlers: RpcHandlers = {
  'conversation.list': unused,
  'conversation.create': unused,
  'conversation.events': unused,
  'conversation.send': unused,
  'conversation.cancel': unused,
  'permission.respond': unused,
  'system.ping': () => ({ coreVersion: '0.0.0-test', uptimeMs: 5 }),
  'harness.list': ({ refresh }) => ({
    harnesses: refresh
      ? [
          {
            id: 'pi',
            displayName: 'pi',
            binaryName: 'pi',
            installed: true,
            executablePath: '/usr/local/bin/pi',
            version: '1.0.0',
            auth: 'unknown',
            problem: null,
            chatSupported: false,
          },
        ]
      : [],
  }),
};

function connect(handlers: RpcHandlers, timeoutMs?: number) {
  const [clientPort, serverPort] = createMemoryPortPair();
  serveRpc(serverPort, handlers);
  return {
    client: createRpcClient(clientPort, timeoutMs === undefined ? {} : { timeoutMs }),
    clientPort,
  };
}

async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).code).toBe(code);
  return error as RpcError;
}

describe('rpc', () => {
  it('round-trips a typed request', async () => {
    const { client } = connect(okHandlers);
    await expect(client.request('system.ping', {})).resolves.toEqual({
      coreVersion: '0.0.0-test',
      uptimeMs: 5,
    });
  });

  it('applies param defaults before calling the handler', async () => {
    const { client } = connect(okHandlers);
    await expect(client.request('harness.list', {})).resolves.toEqual({ harnesses: [] });
    const refreshed = await client.request('harness.list', { refresh: true });
    expect(refreshed.harnesses).toHaveLength(1);
  });

  it('rejects invalid params with InvalidParams', async () => {
    const { client } = connect(okHandlers);
    // Deliberately wrong type to exercise server-side validation.
    const badParams = { refresh: 'yes' } as unknown as { refresh: boolean };
    await expectRpcError(client.request('harness.list', badParams), RpcErrorCode.InvalidParams);
  });

  it('answers unknown methods with MethodNotFound', async () => {
    const [clientPort, serverPort] = createMemoryPortPair();
    serveRpc(serverPort, okHandlers);
    const reply = new Promise<unknown>((resolve) => clientPort.onMessage(resolve));
    clientPort.send({ jsonrpc: '2.0', id: 7, method: 'nope', params: {} });
    await expect(reply).resolves.toMatchObject({
      id: 7,
      error: { code: RpcErrorCode.MethodNotFound },
    });
  });

  it('maps thrown errors to Internal and keeps RpcError codes', async () => {
    const { client } = connect({
      ...okHandlers,
      'system.ping': () => {
        throw new Error('boom');
      },
      'harness.list': () => {
        throw new RpcError(4001, 'custom');
      },
    });
    const internal = await expectRpcError(client.request('system.ping', {}), RpcErrorCode.Internal);
    expect(internal.message).toBe('boom');
    await expectRpcError(client.request('harness.list', {}), 4001);
  });

  it('refuses to send a result that violates the schema', async () => {
    const { client } = connect({
      ...okHandlers,
      'system.ping': () => ({ coreVersion: 1, uptimeMs: -1 }) as never,
    });
    await expectRpcError(client.request('system.ping', {}), RpcErrorCode.Internal);
  });

  it('times out when nobody answers', async () => {
    const [clientPort] = createMemoryPortPair();
    const client = createRpcClient(clientPort, { timeoutMs: 10 });
    await expectRpcError(client.request('system.ping', {}), RpcErrorCode.Timeout);
  });

  it('rejects pending and future requests after close', async () => {
    const [clientPort] = createMemoryPortPair();
    const client = createRpcClient(clientPort);
    const pending = client.request('system.ping', {});
    client.close();
    await expectRpcError(pending, RpcErrorCode.Closed);
    await expectRpcError(client.request('system.ping', {}), RpcErrorCode.Closed);
  });

  it('delivers validated notifications to subscribers only', async () => {
    const [clientPort, serverPort] = createMemoryPortPair();
    const client = createRpcClient(clientPort);
    const received: number[] = [];
    const stop = client.onNotification('conversation.event', (event) => received.push(event.seq));
    const event = {
      conversationId: 'c1',
      seq: 1,
      at: 0,
      body: { type: 'run.started' as const, runId: 'r1' },
    };
    sendNotification(serverPort, 'conversation.event', event);
    await expect.poll(() => received).toEqual([1]);

    // Invalid payloads are dropped by the client, not delivered.
    serverPort.send({ jsonrpc: '2.0', method: 'conversation.event', params: { seq: 'x' } });
    stop();
    sendNotification(serverPort, 'conversation.event', { ...event, seq: 2 });
    await new Promise<void>((r) => setTimeout(() => r(), 10));
    expect(received).toEqual([1]);
    expect(() =>
      sendNotification(serverPort, 'conversation.event', { ...event, seq: -1 }),
    ).toThrow();
  });
});
