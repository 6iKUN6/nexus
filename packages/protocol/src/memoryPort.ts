import type { RpcPort } from './rpc';

/**
 * Two connected in-memory ports. Delivery is asynchronous and messages are
 * deep-copied, mimicking a real MessagePort. Intended for tests.
 */
export function createMemoryPortPair(): [RpcPort, RpcPort] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];

  const makePort = (own: 0 | 1): RpcPort => {
    const peer = own === 0 ? 1 : 0;
    return {
      send(message) {
        const copy: unknown = JSON.parse(JSON.stringify(message));
        void Promise.resolve().then(() => {
          for (const listener of listeners[peer]) listener(copy);
        });
      },
      onMessage(listener) {
        listeners[own].add(listener);
        return () => {
          listeners[own].delete(listener);
        };
      },
    };
  };

  return [makePort(0), makePort(1)];
}
