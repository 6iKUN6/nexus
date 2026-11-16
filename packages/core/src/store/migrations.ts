/**
 * Schema migrations, applied in order and tracked by `PRAGMA user_version`.
 *
 * Hand-written SQL on purpose: a local single-writer database with two tables
 * does not need drizzle-kit's generated snapshots, and the migration history
 * stays reviewable in one file. Drizzle only builds the queries (see schema.ts).
 */
export const MIGRATIONS: string[] = [
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
  // M2 worktree isolation (ADR 0006); existing rows are direct conversations.
  `ALTER TABLE conversations ADD COLUMN isolation TEXT NOT NULL DEFAULT 'direct';
   ALTER TABLE conversations ADD COLUMN base_cwd TEXT;`,
  // M3 delegation (ADR 0008): a task links a parent and a child conversation.
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     parent_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     child_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     goal TEXT NOT NULL,
     acceptance TEXT,
     harness_id TEXT NOT NULL,
     status TEXT NOT NULL,
     result_summary TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX tasks_by_parent ON tasks (parent_conversation_id);
   CREATE INDEX tasks_by_child ON tasks (child_conversation_id);`,
  // M4 handoff (ADR 0011): owner version for compare-and-set, plus the handoff
  // records. Prepared packages are frozen JSON: they are a historical record,
  // so a later schema change must not rewrite them.
  `ALTER TABLE conversations ADD COLUMN owner_version INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE handoffs (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     state TEXT NOT NULL,
     from_harness_id TEXT NOT NULL,
     to_harness_id TEXT NOT NULL,
     package TEXT,
     problem TEXT,
     version INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX handoffs_by_conversation ON handoffs (conversation_id);`,
  // D22: optional per-conversation goal and a pre-selected handoff fallback.
  // Both nullable — ordinary chats never set them.
  `ALTER TABLE conversations ADD COLUMN goal TEXT;
   ALTER TABLE conversations ADD COLUMN fallback_harness_id TEXT;`,
  // D15 delivery semantics (ADR 0017): one durable row per agent message, used
  // as both outbox and inbox; the primary key is the dedupe point.
  `CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     sender_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     recipient_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
     kind TEXT NOT NULL DEFAULT 'message',
     text TEXT NOT NULL,
     reply_to TEXT,
     state TEXT NOT NULL,
     run_id TEXT,
     created_at INTEGER NOT NULL,
     delivered_at INTEGER,
     consumed_at INTEGER
   );
   CREATE INDEX messages_by_sender ON messages (sender_id);
   CREATE INDEX messages_by_recipient ON messages (recipient_id);
   CREATE INDEX messages_by_state ON messages (state);`,
  // D23 tool management (ADR 0020): user-managed MCP servers and the
  // per-conversation opt-in list. env holds ${VAR} placeholders, never values.
  `ALTER TABLE conversations ADD COLUMN enabled_mcp_ids TEXT NOT NULL DEFAULT '[]';
   CREATE TABLE mcp_servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     command TEXT NOT NULL,
     args TEXT NOT NULL,
     env TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
];
