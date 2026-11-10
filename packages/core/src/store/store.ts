import {
  type Conversation,
  type ConversationEvent,
  type ConversationEventBody,
  conversationEventBodySchema,
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
  Pick<Conversation, 'title' | 'state' | 'preview' | 'externalSessionId'>
>;

/** Rows of both tables share the domain shape; this guards column/field drift. */
function toConversation(row: ConversationRow): Conversation {
  return row;
}

function toTask(row: TaskRow): Task {
  return row;
}

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

  close(): void {
    this.client.close();
  }
}
