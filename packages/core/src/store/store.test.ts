import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, ConversationEventBody, Task } from '@nexus/protocol';
import sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './store';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-store-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'nexus.sqlite');
}

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: '调查路由守卫',
  harnessId: 'fake',
  cwd: '/repo',
  isolation: 'direct',
  baseCwd: null,
  externalSessionId: null,
  state: 'idle',
  lastSeq: 0,
  preview: '工作目录 repo',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  parentConversationId: 'parent',
  childConversationId: 'child',
  goal: '补充单元测试',
  acceptance: null,
  harnessId: 'fake',
  status: 'running',
  resultSummary: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('Store', () => {
  it('appends events with a monotonic seq and applies the patch in the same call', () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    store.insertConversation(conversation());

    const first = store.appendEvent('c1', { type: 'text.delta', runId: 'r', text: 'a' }, {}, 10);
    const second = store.appendEvent(
      'c1',
      { type: 'text.delta', runId: 'r', text: 'b' },
      { state: 'running', preview: 'ab' },
      11,
    );

    expect(first.event.seq).toBe(1);
    expect(second.event.seq).toBe(2);
    expect(second.conversation).toMatchObject({ state: 'running', preview: 'ab', lastSeq: 2 });
    expect(store.getConversation('c1')).toEqual(second.conversation);
    expect(store.listEvents('c1', 1).map((e) => e.body)).toEqual([
      { type: 'text.delta', runId: 'r', text: 'b' },
    ]);
  });

  it('reads a legacy v1 database through the current schema, defaulting new columns', () => {
    const path = tempDb();
    // The v1 schema as shipped in M1 — frozen here so the test keeps proving
    // the migration path even after new columns are added.
    const legacy = new sqlite(path);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, harness_id TEXT NOT NULL,
        cwd TEXT NOT NULL, external_session_id TEXT, state TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      ) WITHOUT ROWID;
      PRAGMA user_version = 1;
      INSERT INTO conversations VALUES
        ('c1', '旧会话', 'fake', '/repo', NULL, 'idle', 1, '旧预览', 5, 5);
      INSERT INTO events VALUES
        ('c1', 1, 5, '{"type":"user.message","messageId":"m1","text":"你好"}');
    `);
    legacy.close();

    const store = new Store(path);
    cleanups.push(() => store.close());

    expect(store.getConversation('c1')).toMatchObject({
      id: 'c1',
      title: '旧会话',
      isolation: 'direct',
      baseCwd: null,
      lastSeq: 1,
    });
    expect(store.listEvents('c1', 0).map((e) => e.body)).toEqual([
      { type: 'user.message', messageId: 'm1', text: '你好' },
    ]);
    // New tables exist: delegating into a migrated database works.
    store.insertConversation(conversation({ id: 'c2' }));
    store.insertTask(task({ parentConversationId: 'c2', childConversationId: 'c2' }));
    expect(store.listTasksByParent('c2')).toHaveLength(1);
  });

  it('skips event rows whose body no longer matches the schema', () => {
    const path = tempDb();
    const store = new Store(path);
    store.insertConversation(conversation());
    const body: ConversationEventBody = { type: 'text.delta', runId: 'r', text: 'ok' };
    store.appendEvent('c1', body, {}, 1);
    // Simulate a row written by a newer build (unknown event type): it must be
    // skipped without losing the rows around it.
    const writer = new sqlite(path);
    writer
      .prepare('INSERT INTO events (conversation_id, seq, at, body) VALUES (?, ?, ?, ?)')
      .run('c1', 2, 2, JSON.stringify({ type: 'future.event' }));
    writer.prepare('UPDATE conversations SET last_seq = 2 WHERE id = ?').run('c1');
    writer.close();
    // Reopen so lastSeq is re-read from disk; the out-of-band row is seq 2.
    store.close();
    const reopened = new Store(path);
    reopened.appendEvent('c1', body, {}, 3);
    reopened.close();

    const final = new Store(path);
    cleanups.push(() => final.close());
    expect(final.listEvents('c1', 0).map((e) => e.seq)).toEqual([1, 3]);
  });

  it('reports one inbox entry per conversation, preferring review over failed', () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    // Tasks reference both sides of the link (foreign keys are on).
    for (const id of [
      'parent',
      'other',
      'done',
      'busy',
      'child1',
      'child2',
      'child3',
      'child4',
      'child5',
    ]) {
      store.insertConversation(conversation({ id }));
    }
    store.insertTask(task({ id: 't1', childConversationId: 'child1', status: 'failed' }));
    store.insertTask(task({ id: 't2', childConversationId: 'child2', status: 'review' }));
    store.insertTask(
      task({
        id: 't3',
        parentConversationId: 'other',
        childConversationId: 'child3',
        status: 'failed',
      }),
    );
    store.insertTask(
      task({
        id: 't4',
        parentConversationId: 'done',
        childConversationId: 'child4',
        status: 'accepted',
      }),
    );
    store.insertTask(
      task({
        id: 't5',
        parentConversationId: 'busy',
        childConversationId: 'child5',
        status: 'running',
      }),
    );

    expect(store.listTaskInbox()).toEqual([
      { conversationId: 'other', status: 'failed' },
      { conversationId: 'parent', status: 'review' },
    ]);
  });

  it('updates a task status and keeps the previous summary untouched', () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    store.insertConversation(conversation({ id: 'parent' }));
    store.insertConversation(conversation({ id: 'child' }));
    store.insertTask(task());
    const updated = store.updateTaskStatus('t1', 'review', '做完了', 20);
    expect(updated).toMatchObject({ status: 'review', resultSummary: '做完了', updatedAt: 20 });
    expect(store.getTask('t1')).toEqual(updated);
  });
});
