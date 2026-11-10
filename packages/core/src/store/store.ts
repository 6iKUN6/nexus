import { DatabaseSync } from 'node:sqlite';
import {
  type Conversation,
  type ConversationEvent,
  type ConversationEventBody,
  conversationEventBodySchema,
  type HarnessId,
} from '@nexus/protocol';

/**
 * Persistence on Node's built-in SQLite (`node:sqlite`, available in Electron
 * 45's Node 24; no native module to rebuild — see ADR 0005).
 *
 * Events are append-only with a per-conversation monotonic seq, assigned in
 * the same transaction that updates the conversation row, so a reader that
 * sees `lastSeq = n` can always fetch events 1..n.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     harness_id TEXT NOT NULL,
     cwd TEXT NOT NULL,
     external_session_id TEXT,
     state TEXT NOT NULL,
     last_seq INTEGER NOT NULL DEFAULT 0,
     preview TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE events (
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     body TEXT NOT NULL,
     PRIMARY KEY (conversation_id, seq)
   ) WITHOUT ROWID;`,
];

type ConversationRow = {
  id: string;
  title: string;
  harness_id: string;
  cwd: string;
  external_session_id: string | null;
  state: string;
  last_seq: number;
  preview: string;
  created_at: number;
  updated_at: number;
};

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    harnessId: row.harness_id as HarnessId,
    cwd: row.cwd,
    externalSessionId: row.external_session_id,
    state: row.state as Conversation['state'],
    lastSeq: row.last_seq,
    preview: row.preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ConversationPatch = Partial<
  Pick<Conversation, 'title' | 'state' | 'preview' | 'externalSessionId'>
>;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;',
    );
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let version = row.user_version; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version] ?? '');
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertConversation(conversation: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, title, harness_id, cwd, external_session_id, state, last_seq, preview, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.harnessId,
        conversation.cwd,
        conversation.externalSessionId,
        conversation.state,
        conversation.lastSeq,
        conversation.preview,
        conversation.createdAt,
        conversation.updatedAt,
      );
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : null;
  }

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all() as ConversationRow[];
    return rows.map(toConversation);
  }

  updateConversation(id: string, patch: ConversationPatch, now: number): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error(`Unknown conversation ${id}`);
    const next = { ...current, ...patch, updatedAt: now };
    this.db
      .prepare(
        `UPDATE conversations SET title = ?, state = ?, preview = ?, external_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.title, next.state, next.preview, next.externalSessionId, next.updatedAt, id);
    return next;
  }

  /** Appends an event and applies `patch` atomically; returns both. */
  appendEvent(
    conversationId: string,
    body: ConversationEventBody,
    patch: ConversationPatch,
    now: number,
  ): { event: ConversationEvent; conversation: Conversation } {
    return this.transaction(() => {
      const current = this.getConversation(conversationId);
      if (!current) throw new Error(`Unknown conversation ${conversationId}`);
      const seq = current.lastSeq + 1;
      this.db
        .prepare('INSERT INTO events (conversation_id, seq, at, body) VALUES (?, ?, ?, ?)')
        .run(conversationId, seq, now, JSON.stringify(body));
      this.db
        .prepare('UPDATE conversations SET last_seq = ? WHERE id = ?')
        .run(seq, conversationId);
      const conversation = this.updateConversation(conversationId, patch, now);
      return { event: { conversationId, seq, at: now, body }, conversation };
    });
  }

  listEvents(conversationId: string, afterSeq: number): ConversationEvent[] {
    const rows = this.db
      .prepare(
        'SELECT seq, at, body FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq',
      )
      .all(conversationId, afterSeq) as Array<{ seq: number; at: number; body: string }>;
    return rows.flatMap((row) => {
      // A row that no longer matches the schema (e.g. after a downgrade) is skipped, not fatal.
      const parsed = conversationEventBodySchema.safeParse(JSON.parse(row.body));
      return parsed.success
        ? [{ conversationId, seq: row.seq, at: row.at, body: parsed.data }]
        : [];
    });
  }

  close(): void {
    this.db.close();
  }
}
