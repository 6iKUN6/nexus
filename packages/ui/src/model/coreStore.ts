import type {
  Conversation,
  ConversationEvent,
  HarnessId,
  HarnessInfo,
  RpcClient,
} from '@nexus/protocol';

/**
 * Client-side mirror of core state, fed by RPC + notifications.
 *
 * - Conversations (metadata) are always kept in sync.
 * - Event logs are loaded per conversation on demand (when opened) and then
 *   kept live. Duplicates are dropped by seq; a gap triggers a refill from
 *   the last known seq, so a missed notification never corrupts the timeline.
 * - Listeners are notified at most once per animation frame, so streaming
 *   deltas don't re-render the tree per token.
 */

export type CoreSnapshot = {
  status: 'connecting' | 'ready' | 'failed';
  error: string | null;
  coreVersion: string | null;
  harnesses: HarnessInfo[] | null;
  conversations: Conversation[];
  events: ReadonlyMap<string, readonly ConversationEvent[]>;
};

type Listener = () => void;

const byUpdatedDesc = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;

export class CoreStore {
  private snapshot: CoreSnapshot = {
    status: 'connecting',
    error: null,
    coreVersion: null,
    harnesses: null,
    conversations: [],
    events: new Map(),
  };
  private readonly listeners = new Set<Listener>();
  private client: RpcClient | null = null;
  private readonly loading = new Map<string, Promise<void>>();
  private emitScheduled = false;
  private started: Promise<void> | null = null;

  constructor(private readonly connect: () => Promise<RpcClient>) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CoreSnapshot => this.snapshot;

  /** Connects and loads the conversation list. Idempotent (safe under StrictMode). */
  start(): Promise<void> {
    this.started ??= this.doStart();
    return this.started;
  }

  private async doStart(): Promise<void> {
    try {
      const client = await this.connect();
      this.client = client;
      client.onNotification('conversation.updated', (c) => this.upsert(c));
      client.onNotification('conversation.event', (e) => this.receive(e));
      const [{ coreVersion }, { conversations }] = await Promise.all([
        client.request('system.ping', {}),
        client.request('conversation.list', {}),
      ]);
      this.set({
        status: 'ready',
        coreVersion,
        conversations: [...conversations].sort(byUpdatedDesc),
      });
      void this.refreshHarnesses(false);
    } catch (error) {
      this.set({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  async refreshHarnesses(refresh: boolean): Promise<void> {
    const { harnesses } = await this.rpc().request('harness.list', { refresh });
    this.set({ harnesses });
  }

  /** Loads (or tops up) the event log of a conversation. Idempotent while in flight. */
  loadEvents(conversationId: string): Promise<void> {
    const inFlight = this.loading.get(conversationId);
    if (inFlight) return inFlight;
    const afterSeq = this.snapshot.events.get(conversationId)?.at(-1)?.seq ?? 0;
    const task = this.rpc()
      .request('conversation.events', { conversationId, afterSeq })
      .then(({ events }) => this.merge(conversationId, events))
      .finally(() => this.loading.delete(conversationId));
    this.loading.set(conversationId, task);
    return task;
  }

  async createConversation(input: { harnessId: HarnessId; cwd: string; title?: string }) {
    const { conversation } = await this.rpc().request('conversation.create', input);
    this.upsert(conversation);
    this.merge(conversation.id, []);
    return conversation;
  }

  send(conversationId: string, text: string) {
    return this.rpc().request('conversation.send', { conversationId, text });
  }

  cancel(conversationId: string) {
    return this.rpc().request('conversation.cancel', { conversationId });
  }

  respondToPermission(conversationId: string, requestId: string, optionId: string) {
    return this.rpc().request('permission.respond', { conversationId, requestId, optionId });
  }

  // --- internals ---

  private rpc(): RpcClient {
    if (!this.client) throw new Error('Core is not connected');
    return this.client;
  }

  private upsert(conversation: Conversation) {
    const others = this.snapshot.conversations.filter((c) => c.id !== conversation.id);
    this.set({ conversations: [conversation, ...others].sort(byUpdatedDesc) });
    // Metadata may announce events we have not seen (e.g. notification lost): refill.
    const known = this.snapshot.events.get(conversation.id);
    if (known && (known.at(-1)?.seq ?? 0) < conversation.lastSeq)
      void this.loadEvents(conversation.id);
  }

  private receive(event: ConversationEvent) {
    const known = this.snapshot.events.get(event.conversationId);
    if (!known) return; // not opened yet; loaded in full on open
    const last = known.at(-1)?.seq ?? 0;
    if (event.seq <= last) return;
    if (event.seq === last + 1 && !this.loading.has(event.conversationId)) {
      this.merge(event.conversationId, [event]);
    } else {
      void this.loadEvents(event.conversationId);
    }
  }

  private merge(conversationId: string, incoming: readonly ConversationEvent[]) {
    const known = this.snapshot.events.get(conversationId) ?? [];
    const last = known.at(-1)?.seq ?? 0;
    const fresh = incoming.filter((e) => e.seq > last);
    if (fresh.length === 0 && this.snapshot.events.has(conversationId)) return;
    const events = new Map(this.snapshot.events);
    events.set(conversationId, [...known, ...fresh]);
    this.set({ events });
  }

  private set(patch: Partial<CoreSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    const flush = () => {
      this.emitScheduled = false;
      for (const listener of this.listeners) listener();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }
}
