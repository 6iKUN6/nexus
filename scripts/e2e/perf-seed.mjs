// Seeds a perf fixture into an idle Nexus database: 10 conversations, each
// with 165 completed runs (7 events per run ≈ 1,155 events), i.e. ~11,500
// events in total — the acceptance budget's "累计 10,000 条消息" (D21).
// The app must be STOPPED while this runs (single writer to SQLite).
//
//   node perf-seed.mjs <nexus.sqlite path> <project dir>

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const Database = require('better-sqlite3');

const [dbPath, projectDir] = process.argv.slice(2);
if (!dbPath || !projectDir) {
  console.error('usage: node perf-seed.mjs <nexus.sqlite> <project dir>');
  process.exit(1);
}

const RUNS_PER_CONVERSATION = 165;
const CONVERSATIONS = 10;

const db = new Database(dbPath);
const now = Date.now();
const insertConversation = db.prepare(
  `INSERT INTO conversations
   (id, title, harness_id, cwd, isolation, base_cwd, external_session_id, owner_version,
    state, last_seq, preview, goal, fallback_harness_id, enabled_mcp_ids, created_at, updated_at)
   VALUES (?, ?, 'fake', ?, 'worktree', ?, NULL, 1, 'idle', ?, ?, NULL, NULL, '[]', ?, ?)`,
);
const insertEvent = db.prepare(
  'INSERT INTO events (conversation_id, seq, at, body) VALUES (?, ?, ?, ?)',
);

const seed = db.transaction(() => {
  for (let c = 1; c <= CONVERSATIONS; c++) {
    const tag = `会话-${String(c).padStart(2, '0')}`;
    const id = randomUUID();
    // Worktree isolation like a real conversation; the dir must exist because
    // the fake harness spawns in it during the load test.
    const cwd = join(projectDir, '.perf-worktrees', tag);
    mkdirSync(cwd, { recursive: true });
    // The events reference the conversation row (FK), so insert it first and
    // fix lastSeq/preview after the run loop.
    // Spread the history over the past day so timestamps increase with seq.
    const base = now - RUNS_PER_CONVERSATION * 7 * 60_000;
    insertConversation.run(id, `压测${tag}`, cwd, projectDir, 0, '', base, base);
    let seq = 0;
    for (let r = 1; r <= RUNS_PER_CONVERSATION; r++) {
      const runId = `run-${tag}-${r}`;
      const at = () => base + seq * 60_000;
      const bodies = [
        {
          type: 'user.message',
          messageId: `m-${tag}-${r}`,
          text: `${tag} 第${r}轮 提问：调查路由守卫的空指针`,
        },
        { type: 'run.started', runId },
        { type: 'text.delta', runId, text: `${tag} 第${r}轮 回答：空指针发生在回调里，` },
        { type: 'text.delta', runId, text: '守卫在参数缺失时没有早退。已在 guard.ts 加上默认值。' },
        {
          type: 'tool.started',
          runId,
          toolCallId: `tc-${tag}-${r}`,
          name: 'Grep',
          input: { pattern: 'guard' },
        },
        {
          type: 'tool.completed',
          runId,
          toolCallId: `tc-${tag}-${r}`,
          status: 'ok',
          summary: '3 处匹配',
        },
        { type: 'run.completed', runId, stopReason: 'end_turn', durationMs: 1200 },
      ];
      for (const body of bodies) {
        seq += 1;
        insertEvent.run(id, seq, at(), JSON.stringify(body));
      }
    }
    db.prepare(
      'UPDATE conversations SET last_seq = ?, preview = ?, updated_at = ? WHERE id = ?',
    ).run(seq, `${tag} 第${RUNS_PER_CONVERSATION}轮 回答节选`, now, id);
  }
});
seed();
console.log(
  `seeded ${CONVERSATIONS} conversations × ${RUNS_PER_CONVERSATION * 7} events into ${dbPath}`,
);
db.close();
