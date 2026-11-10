import {
  type Conversation,
  type ConversationEvent,
  type ConversationEventBody,
  conversationEventBodySchema,
  type Handoff,
  type Task,
  type TaskStatus,
} from '@nexus/protocol';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { MIGRATIONS } from './migrations';
import {
  type ConversationInsert,
  type ConversationRow,
  conversations,
  events,
  type HandoffRow,
  handoffs,
  type TaskRow,
  tasks,
} from './schema';

/**
 * Persistence on SQLite through Drizzle (ADR 0009).
 *
 * Events are append-only with a per-conversation monotonic seq, assigned in
 * the same transaction that updates the conversation row, so a reader that
 * sees `lastSeq = n` can always fetch events 1..n.
 *
 * Rows already use the domain's camelCase field names (see schema.ts), so a
 * row is a Conversation/Task directly — adding a column to one without the
 * other fails to compile instead of drifting silently.
 */

export type ConversationPatch = Partial<
  Pick<
    Conversation,
    'title' | 'state' | 'preview' | 'externalSessionId' | 'harnessId' | 'ownerVersion'
  >
>;

/** Rows of both tables share the domain shape; this guards column/field drift. */
function toConversation(row: ConversationRow): Conversation {
  return row;
}

function toTask(row: TaskRow): Task {
  return row;
}

function toHandoff(row: HandoffRow): Handoff {
  return row;
}

/** Thrown when a handoff commit races another change; nothing is written. */
export class VersionConflict extends Error {}

export class Store {
  private readonly client: Database.Database;
  private readonly db;

  constructor(path: string) {
    this.client = new Database(path);
    this.client.pragma('journal_mode = WAL');
    this.client.pragma('foreign_keys = ON');
    this.client.pragma('busy_timeout = 2000');
    this.db = drizzle(this.client);
    this.migrate();
  }

  private migrate(): void {
    const current = this.client.pragma('user_version', { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.client
        .transaction(() => {
          this.client.exec(MIGRATIONS[version] ?? '');
          this.client.pragma(`user_version = ${version + 1}`);
        })
        .immediate();
    }
  }

  insertConversation(conversation: Conversation): void {
    this.db.insert(conversations).values(conversation).run();
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return row ? toConversation(row) : null;
  }

  listConversations(): Conversation[] {
    return this.db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .all()
      .map(toConversation);
  }

  updateConversation(id: string, patch: ConversationPatch, now: number): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error(`Unknown conversation ${id}`);
    const next: Conversation = { ...current, ...patch, updatedAt: now };
    const update: Partial<ConversationInsert> = { ...patch, updatedAt: now };
    this.db.update(conversations).set(update).where(eq(conversations.id, id)).run();
    return next;
  }

  /** Appends an event and applies `patch` atomically; returns both. */
  appendEvent(
    conversationId: string,
    body: ConversationEventBody,
    patch: ConversationPatch,
    now: number,
  ): { event: ConversationEvent; conversation: Conversation } {
    return this.db.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get();
        if (!current) throw new Error(`Unknown conversation ${conversationId}`);
        const seq = current.lastSeq + 1;
        tx.insert(events).values({ conversationId, seq, at: now, body }).run();
        tx.update(conversations)
          .set({ lastSeq: seq, ...patch, updatedAt: now })
          .where(eq(conversations.id, conversationId))
          .run();
        const conversation: Conversation = { ...current, ...patch, lastSeq: seq, updatedAt: now };
        return { event: { conversationId, seq, at: now, body }, conversation };
      },
      { behavior: 'immediate' },
    );
  }

  listEvents(conversationId: string, afterSeq: number): ConversationEvent[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, conversationId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .all();
    return rows.flatMap((row) => {
      // A row that no longer matches the schema (e.g. after a downgrade) is skipped, not fatal.
      const parsed = conversationEventBodySchema.safeParse(row.body);
      return parsed.success
        ? [{ conversationId, seq: row.seq, at: row.at, body: parsed.data }]
        : [];
    });
  }

  insertTask(task: Task): void {
    this.db.insert(tasks).values(task).run();
  }

  updateTaskStatus(
    id: string,
    status: TaskStatus,
    resultSummary: string | null,
    now: number,
  ): Task {
    const current = this.getTask(id);
    if (!current) throw new Error(`Unknown task ${id}`);
    this.db
      .update(tasks)
      .set({ status, resultSummary, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
    return { ...current, status, resultSummary, updatedAt: now };
  }

  getTask(id: string): Task | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? toTask(row) : null;
  }

  listTasksByParent(parentConversationId: string): Task[] {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentConversationId, parentConversationId))
      .orderBy(asc(tasks.createdAt))
      .all()
      .map(toTask);
  }

  getTaskByChild(childConversationId: string): Task | null {
    const row = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.childConversationId, childConversationId))
      .get();
    return row ? toTask(row) : null;
  }

  /**
   * Conversations with tasks waiting on the user (M3 inbox). A conversation
   * with both a failed and a reviewable task is reported once, as `review`:
   * the user's next action is the acceptance, not the failure.
   */
  listTaskInbox(): Array<{ conversationId: string; status: TaskStatus }> {
    const rows = this.db
      .selectDistinct({
        conversationId: tasks.parentConversationId,
        status: tasks.status,
      })
      .from(tasks)
      .where(inArray(tasks.status, ['review', 'failed'] satisfies TaskStatus[]))
      .orderBy(asc(tasks.parentConversationId))
      .all();
    const byParent = new Map<string, TaskStatus>();
    for (const row of rows) {
      const known = byParent.get(row.conversationId);
      byParent.set(row.conversationId, known === 'review' ? known : row.status);
    }
    return [...byParent].map(([conversationId, status]) => ({ conversationId, status }));
  }

  // --- handoffs (M4, ADR 0011) ---

  insertHandoff(handoff: Handoff): void {
    this.db.insert(handoffs).values(handoff).run();
  }

  getHandoff(id: string): Handoff | null {
    const row = this.db.select().from(handoffs).where(eq(handoffs.id, id)).get();
    return row ? toHandoff(row) : null;
  }

  /** Newest first; used to show the latest handoff on the conversation. */
  listHandoffs(conversationId: string): Handoff[] {
    return this.db
      .select()
      .from(handoffs)
      .where(eq(handoffs.conversationId, conversationId))
      .orderBy(desc(handoffs.createdAt))
      .all()
      .map(toHandoff);
  }

  /** Handoffs that have not reached a final state (used by boot-time reconciliation). */
  listOpenHandoffs(): Handoff[] {
    return this.db
      .select()
      .from(handoffs)
      .where(inArray(handoffs.state, ['stopping_source', 'prepared', 'committed']))
      .orderBy(asc(handoffs.createdAt))
      .all()
      .map(toHandoff);
  }

  /** Updates a handoff with optimistic concurrency: `expectedVersion` must match. */
  updateHandoff(
    id: string,
    patch: Partial<Pick<Handoff, 'state' | 'problem' | 'package'>>,
    expectedVersion: number,
    now: number,
  ): Handoff {
    const current = this.getHandoff(id);
    if (!current) throw new Error(`Unknown handoff ${id}`);
    const next = nextHandoff(current, patch, expectedVersion, now);
    this.db
      .update(handoffs)
      .set({ ...patch, version: next.version, updatedAt: now })
      .where(and(eq(handoffs.id, id), eq(handoffs.version, expectedVersion)))
      .run();
    return next;
  }

  /**
   * Commits a prepared handoff atomically: ownership moves to the receiving
   * harness, the previous owner's session id is forgotten (it is only
   * meaningful inside the adapter that created it), and the handoff advances.
   * Any mismatch — the handoff version, or the owner version the package was
   * frozen against — aborts with nothing written.
   */
  commitHandoff(input: {
    handoffId: string;
    expectedHandoffVersion: number;
    preview: string;
    now: number;
  }): { handoff: Handoff; conversation: Conversation } {
    return this.db.transaction(
      (tx) => {
        const handoffRow = tx.select().from(handoffs).where(eq(handoffs.id, input.handoffId)).get();
        if (!handoffRow) throw new Error(`Unknown handoff ${input.handoffId}`);
        const handoff = toHandoff(handoffRow);
        const frozen = handoff.package;
        if (handoff.state !== 'prepared' || handoff.version !== input.expectedHandoffVersion) {
          throw new VersionConflict('交接内容已变化，请重新准备');
        }
        if (!frozen) throw new Error(`Handoff ${handoff.id} has no package`);
        const conversationRow = tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, handoff.conversationId))
          .get();
        if (!conversationRow) throw new Error(`Unknown conversation ${handoff.conversationId}`);
        const conversation = toConversation(conversationRow);
        if (
          conversation.harnessId !== handoff.fromHarnessId ||
          conversation.ownerVersion !== frozen.ownerVersion
        ) {
          throw new VersionConflict('任务负责人已变化，请重新准备交接');
        }
        const ownerVersion = conversation.ownerVersion + 1;
        tx.update(conversations)
          .set({
            harnessId: handoff.toHarnessId,
            externalSessionId: null,
            ownerVersion,
            preview: input.preview,
            updatedAt: input.now,
          })
          .where(eq(conversations.id, conversation.id))
          .run();
        const committed = nextHandoff(
          handoff,
          { state: 'committed' },
          input.expectedHandoffVersion,
          input.now,
        );
        tx.update(handoffs)
          .set({ state: committed.state, version: committed.version, updatedAt: input.now })
          .where(eq(handoffs.id, handoff.id))
          .run();
        return {
          handoff: committed,
          conversation: {
            ...conversation,
            harnessId: handoff.toHarnessId,
            externalSessionId: null,
            ownerVersion,
            preview: input.preview,
            updatedAt: input.now,
          },
        };
      },
      { behavior: 'immediate' },
    );
  }

  close(): void {
    this.client.close();
  }
}

/** Applies a handoff patch under optimistic concurrency; throws on a stale version. */
function nextHandoff(
  current: Handoff,
  patch: Partial<Pick<Handoff, 'state' | 'problem' | 'package'>>,
  expectedVersion: number,
  now: number,
): Handoff {
  if (current.version !== expectedVersion) throw new VersionConflict('交接内容已变化，请重新准备');
  return { ...current, ...patch, version: current.version + 1, updatedAt: now };
}
