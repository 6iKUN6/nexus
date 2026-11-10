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
];
