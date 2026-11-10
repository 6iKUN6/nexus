import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter, type FakeStep } from '@nexus/adapter-fake';
import {
  type Conversation,
  type ConversationEvent,
  createMemoryPortPair,
  createRpcClient,
  type RpcClient,
} from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { type Core, createCore } from '../core';
import type { GitRun, WorktreeManager } from '../worktree/gitWorktree';

/**
 * Delegation (M3) through the core RPC surface. Worktree creation and git are
 * faked — delegation behaviour is about task state, not git itself (that is
 * covered in gitWorktree.test.ts).
 */

const fakeWorktrees: WorktreeManager = {
  create: async (cwd: string, id: string) => ({
    cwd: join(cwd, '.fake-worktrees', id),
    repoRoot: cwd,
  }),
};
const fakeGitRun: GitRun = async () => ({ code: 0, stdout: '', stderr: '' });

/** Real directory for cwd stat checks (git itself is faked). */
const repoDir = mkdtempSync(join(tmpdir(), 'nexus-task-repo-'));

function connect(options: {
  script: (prompt: string) => FakeStep[];
  databasePath?: string;
  stepDelayMs?: number;
}) {
  const core = createCore({
    version: '0.0.0-test',
    databasePath: options.databasePath ?? ':memory:',
    adapters: {
      fake: createFakeAdapter({ script: options.script, stepDelayMs: options.stepDelayMs }),
    },
    detectHarnesses: async () => [],
    resolvePath: async () => '/bin',
    worktrees: fakeWorktrees,
    gitRun: fakeGitRun,
  });
  const [clientPort, corePort] = createMemoryPortPair();
  core.attach(corePort);
  const pushed: ConversationEvent[] = [];
  const client = createRpcClient(clientPort);
  client.onNotification('conversation.event', (event) => pushed.push(event));
  return { core, client, pushed };
}

const replyScript = (prompt: string): FakeStep[] => [
  { kind: 'text', text: `结果：已完成「${prompt.slice(0, 20)}」的调查` },
];

async function createParent(client: RpcClient): Promise<Conversation> {
  const { conversation } = await client.request('conversation.create', {
    harnessId: 'fake',
    cwd: repoDir,
    isolation: 'direct',
  });
  return conversation;
}

async function waitFor(predicate: () => boolean, what: string) {
  await expect.poll(predicate, { timeout: 5000, interval: 10 }).toBe(true);
}

describe('task delegation (M3)', () => {
  it('delegates: child conversation, brief prompt, review, accept', async () => {
    const { client, pushed } = connect({ script: replyScript });
    const parent = await createParent(client);

    const { task, childConversation } = await client.request('task.delegate', {
      conversationId: parent.id,
      goal: '调查路由守卫的空指针',
      acceptance: '列出所有受影响的守卫',
      harnessId: 'fake',
    });
    expect(task.status).toBe('running');
    expect(childConversation.harnessId).toBe('fake');
    expect(childConversation.isolation).toBe('worktree');
    expect(childConversation.cwd).toContain('.fake-worktrees');
    expect(childConversation.title).toBe('调查路由守卫的空指针');

    // The parent's log opens the delegation card; the child starts with the brief.
    const delegated = pushed.find(
      (e) => e.conversationId === parent.id && e.body.type === 'task.delegated',
    );
    expect(delegated?.body).toMatchObject({
      type: 'task.delegated',
      taskId: task.id,
      childConversationId: childConversation.id,
      acceptance: '列出所有受影响的守卫',
    });
    const brief = pushed.find(
      (e) => e.conversationId === childConversation.id && e.body.type === 'user.message',
    );
    expect(brief?.body).toMatchObject({ type: 'user.message' });
    if (!brief) throw new Error('expected the brief event');
    const briefText = (brief.body as { text: string }).text;
    expect(briefText).toContain('调查路由守卫的空指针');
    expect(briefText).toContain('列出所有受影响的守卫');

    // Child finishes → task goes to review with the run's text as summary.
    await waitFor(
      () =>
        pushed.some(
          (e) => e.conversationId === childConversation.id && e.body.type === 'run.completed',
        ),
      'child run.completed',
    );
    await waitFor(() => {
      const updated = pushed.findLast(
        (e) => e.conversationId === parent.id && e.body.type === 'task.updated',
      );
      return updated?.body.type === 'task.updated' && updated.body.status === 'review';
    }, 'task.updated(review)');

    const { children } = await client.request('task.list', { conversationId: parent.id });
    expect(children[0]?.status).toBe('review');
    expect(children[0]?.resultSummary).toContain('结果：已完成');

    const { items } = await client.request('task.inbox', {});
    expect(items).toEqual([{ conversationId: parent.id, status: 'review' }]);

    // The child links back to its parent task.
    const { parent: parentTask } = await client.request('task.list', {
      conversationId: childConversation.id,
    });
    expect(parentTask?.id).toBe(task.id);

    const accepted = await client.request('task.respond', { taskId: task.id, action: 'accept' });
    expect(accepted.task.status).toBe('accepted');
    expect((await client.request('task.inbox', {})).items).toEqual([]);
  });

  it('request_changes sends feedback to the child and returns to review', async () => {
    const { client, pushed } = connect({ script: replyScript });
    const parent = await createParent(client);
    const { task, childConversation } = await client.request('task.delegate', {
      conversationId: parent.id,
      goal: '补充单元测试',
      acceptance: null,
      harnessId: 'fake',
    });
    await waitFor(() => {
      const last = pushed.findLast(
        (e) => e.conversationId === parent.id && e.body.type === 'task.updated',
      )?.body;
      return last?.type === 'task.updated' && last.status === 'review';
    }, 'review');

    await client.request('task.respond', {
      taskId: task.id,
      action: 'request_changes',
      feedback: '还缺少边界用例',
    });
    // The task reopened with the feedback on the parent's log. (The fake
    // child answers instantly, so the stored status may be review again by
    // the time we read it — the event sequence is the stable signal.)
    const reopened = pushed.findLast(
      (e) =>
        e.conversationId === parent.id &&
        e.body.type === 'task.updated' &&
        e.body.status === 'running',
    )?.body;
    expect(reopened).toMatchObject({ type: 'task.updated', summary: '还缺少边界用例' });

    // The child receives the feedback as a normal prompt and re-runs.
    const feedback = pushed.findLast(
      (e) => e.conversationId === childConversation.id && e.body.type === 'user.message',
    );
    if (!feedback) throw new Error('expected the feedback message');
    expect((feedback.body as { text: string }).text).toContain('还缺少边界用例');
    await waitFor(() => {
      const updates = pushed.filter(
        (e) => e.conversationId === parent.id && e.body.type === 'task.updated',
      );
      const last = updates.at(-1)?.body;
      return last?.type === 'task.updated' && last.status === 'review';
    }, 'back to review');
  });

  it('marks the task failed when the child run fails', async () => {
    const failScript = (): FakeStep[] => [{ kind: 'fail', code: 'boom', message: '磁盘起火' }];
    const { client, pushed } = connect({ script: failScript });
    const parent = await createParent(client);
    const { task } = await client.request('task.delegate', {
      conversationId: parent.id,
      goal: '会失败的子任务',
      acceptance: null,
      harnessId: 'fake',
    });
    await waitFor(() => {
      const last = pushed.findLast(
        (e) => e.conversationId === parent.id && e.body.type === 'task.updated',
      )?.body;
      return last?.type === 'task.updated' && last.status === 'failed';
    }, 'task.updated(failed)');
    const { items } = await client.request('task.inbox', {});
    expect(items).toEqual([{ conversationId: parent.id, status: 'failed' }]);
    // Accepting a failed task is rejected; only review can be accepted.
    await expect(
      client.request('task.respond', { taskId: task.id, action: 'accept' }),
    ).rejects.toThrow('只有待验收的子任务能通过验收');
  });

  it('rejects delegating from a child conversation (one level only)', async () => {
    const { client } = connect({ script: replyScript });
    const parent = await createParent(client);
    const { childConversation } = await client.request('task.delegate', {
      conversationId: parent.id,
      goal: '第一层子任务',
      acceptance: null,
      harnessId: 'fake',
    });
    await expect(
      client.request('task.delegate', {
        conversationId: childConversation.id,
        goal: '第二层',
        acceptance: null,
        harnessId: 'fake',
      }),
    ).rejects.toThrow('子任务不能再次委派');
  });

  it('reconciles tasks after a restart: an interrupted child marks the task failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-tasks-'));
    try {
      const databasePath = join(dir, 'nexus.sqlite');
      // Core A: child starts a slow run; core is disposed before it finishes.
      const a = connect({ script: replyScript, databasePath, stepDelayMs: 60_000 });
      const parent = await createParent(a.client);
      const { task } = await a.client.request('task.delegate', {
        conversationId: parent.id,
        goal: '长跑子任务',
        acceptance: null,
        harnessId: 'fake',
      });
      await waitFor(() => a.pushed.some((e) => e.body.type === 'run.started'), 'child run started');
      await a.core.dispose();

      // Core B on the same database: recovery closes the run as interrupted,
      // and the task must follow to failed (never re-run).
      const b = connect({ script: replyScript, databasePath });
      const { children } = await b.client.request('task.list', { conversationId: parent.id });
      expect(children[0]?.status).toBe('failed');
      const events = await b.client.request('conversation.events', {
        conversationId: parent.id,
      });
      const lastUpdate = events.events.findLast((e) => e.body.type === 'task.updated')?.body;
      expect(lastUpdate).toMatchObject({ type: 'task.updated', taskId: task.id, status: 'failed' });
      await b.core.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
