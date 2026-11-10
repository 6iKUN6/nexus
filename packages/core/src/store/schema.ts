import type {
  ConversationEventBody,
  ConversationState,
  Handoff,
  HarnessId,
  Isolation,
  TaskStatus,
} from '@nexus/protocol';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle table definitions (ADR 0009). Columns carry the protocol's union
 * types, so every row read is typed without casts, and `select()` returns the
 * same shape the domain type expects.
 *
 * DDL itself lives in `migrations.ts`: hand-written SQL is still the cheapest
 * way to evolve a local, single-writer database.
 */

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  harnessId: text('harness_id').$type<HarnessId>().notNull(),
  cwd: text('cwd').notNull(),
  isolation: text('isolation').$type<Isolation>().notNull(),
  baseCwd: text('base_cwd'),
  externalSessionId: text('external_session_id'),
  ownerVersion: integer('owner_version').notNull(),
  state: text('state').$type<ConversationState>().notNull(),
  lastSeq: integer('last_seq').notNull(),
  preview: text('preview').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const events = sqliteTable('events', {
  conversationId: text('conversation_id').notNull(),
  seq: integer('seq').notNull(),
  at: integer('at').notNull(),
  /** Stored as JSON; parsed by the driver, validated on read. */
  body: text('body', { mode: 'json' }).$type<ConversationEventBody>().notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  parentConversationId: text('parent_conversation_id').notNull(),
  childConversationId: text('child_conversation_id').notNull(),
  goal: text('goal').notNull(),
  acceptance: text('acceptance'),
  harnessId: text('harness_id').$type<HarnessId>().notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  resultSummary: text('result_summary'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const handoffs = sqliteTable('handoffs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  state: text('state').$type<Handoff['state']>().notNull(),
  fromHarnessId: text('from_harness_id').$type<HarnessId>().notNull(),
  toHarnessId: text('to_harness_id').$type<HarnessId>().notNull(),
  /** Frozen at `prepared`; null before that. */
  package: text('package', { mode: 'json' }).$type<Handoff['package']>(),
  problem: text('problem'),
  version: integer('version').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type HandoffRow = typeof handoffs.$inferSelect;
