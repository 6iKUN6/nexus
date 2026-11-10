import { createRpcClient, type RpcClient, type RpcPort } from '@nexus/protocol';

/**
 * Receives the MessagePort that main transfers via the preload and wraps it
 * in an RPC client.
 *
 * The listener is registered at module load, not when React mounts: main
 * sends the port on `did-finish-load`, which can fire before effects run,
 * and a missed message would leave the UI connecting forever (seen on fast
 * reloads). The port is buffered until someone asks for it.
 */

function toRpcPort(port: MessagePort): RpcPort {
  return {
    send: (message) => port.postMessage(message),
    onMessage(listener) {
      const handler = (event: MessageEvent) => listener(event.data);
      port.addEventListener('message', handler);
      port.start();
      return () => port.removeEventListener('message', handler);
    },
  };
}

let receivedPort: MessagePort | null = null;
const waiters: Array<(port: MessagePort) => void> = [];

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { type?: unknown } | null;
  const port = event.ports[0];
  if (data?.type !== 'nexus:core-port' || !port) return;
  receivedPort = port;
  for (const resolve of waiters.splice(0)) resolve(port);
});

let connection: Promise<RpcClient> | null = null;

export function connectToCore(timeoutMs = 10_000): Promise<RpcClient> {
  connection ??= new Promise<RpcClient>((resolve, reject) => {
    const done = (port: MessagePort) => {
      window.clearTimeout(timer);
      resolve(createRpcClient(toRpcPort(port)));
    };
    const timer = window.setTimeout(() => {
      const index = waiters.indexOf(done);
      if (index !== -1) waiters.splice(index, 1);
      connection = null;
      reject(new Error(`未在 ${timeoutMs}ms 内收到核心连接`));
    }, timeoutMs);
    if (receivedPort) done(receivedPort);
    else waiters.push(done);
  });
  return connection;
}
