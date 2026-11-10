import {
  type Conversation,
  type ConversationEvent,
  createMemoryPortPair,
  createRpcClient,
  type RpcHandlers,
  sendNotification,
  serveRpc,
} from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { CoreStore } from './coreStore';

const conversation: Conversation = {
  id: 'c1',
  title: 't',
  harnessId: 'fake',
  cwd: '/w',
  isolation: 'direct',
  baseCwd: null,
  externalSessionId: null,
  ownerVersion: 1,
  state: 'idle',
  lastSeq: 0,
  preview: '',
  createdAt: 1,
  updatedAt: 1,
};

const ev = (seq: number): ConversationEvent => ({
  conversationId: 'c1',
  seq,
  at: seq,
  body: { type: 'text.delta', runId: 'r', text: String(seq) },
});

function setup(history: ConversationEvent[]) {
  const [clientPort, serverPort] = createMemoryPortPair();
  const requested: number[] = [];
  const unused = () => {
    throw new Error('unused');
  };
  const handlers: RpcHandlers = {
    'system.ping': () => ({ coreVersion: 'test', uptimeMs: 0 }),
    'harness.list': () => ({ harnesses: [] }),
    'conversation.list': () => ({ conversations: [conversation] }),
    'conversation.events': ({ afterSeq }) => {
      requested.push(afterSeq);
      return { events: history.filter((e) => e.seq > afterSeq) };
    },
    'conversation.create': unused,
    'path.inspect': unused,
    'conversation.send': unused,
    'conversation.cancel': unused,
    'permission.respond': unused,
    'task.delegate': unused,
    'task.list': unused,
    'task.inbox': () => ({ items: [] }),
    'task.respond': unused,
    'handoff.prepare': unused,
    'handoff.commit': unused,
    'handoff.cancel': unused,
  };
  serveRpc(serverPort, handlers);
  const store = new CoreStore(async () => createRpcClient(clientPort));
  const seqs = () =>
    store
      .getSnapshot()
      .events.get('c1')
      ?.map((e) => e.seq) ?? [];
  return { store, serverPort, requested, seqs };
}

describe('CoreStore', () => {
  it('loads history on open, then appends live events and drops duplicates', async () => {
    const history = [ev(1), ev(2)];
    const { store, serverPort, seqs } = setup(history);
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', coreVersion: 'test' });
    await store.loadEvents('c1');
    expect(seqs()).toEqual([1, 2]);

    sendNotification(serverPort, 'conversation.event', ev(3));
    sendNotification(serverPort, 'conversation.event', ev(3));
    sendNotification(serverPort, 'conversation.event', ev(2));
    await expect.poll(seqs).toEqual([1, 2, 3]);
  });

  it('refills from the last known seq when a notification is missed', async () => {
    // `history` is the server's log; the handler reads it live.
    const history = [ev(1)];
    const { store, serverPort, requested, seqs } = setup(history);
    await store.start();
    await store.loadEvents('c1');
    expect(seqs()).toEqual([1]);

    // Server appends 2..4, but the client only hears about #4.
    history.push(ev(2), ev(3), ev(4));
    sendNotification(serverPort, 'conversation.event', ev(4));
    await expect.poll(seqs).toEqual([1, 2, 3, 4]);
    expect(requested).toEqual([0, 1]);
  });

  it('ignores events of conversations that were never opened', async () => {
    const { store, serverPort } = setup([]);
    await store.start();
    sendNotification(serverPort, 'conversation.event', ev(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getSnapshot().events.has('c1')).toBe(false);
  });
});
