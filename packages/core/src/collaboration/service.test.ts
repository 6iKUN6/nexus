import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '@nexus/adapter-fake';
import type { Conversation, ConversationEvent, Task } from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../conversations/conversationService';
import { MessageService } from '../messaging/messageService';
import { Store } from '../store/store';
import { TaskService } from '../tasks/taskService';
import { CollaborationErrorCode, CollaborationService } from './service';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-collab-service-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup() {
  const store = new Store(':memory:');
  cleanups.push(() => store.close());
  const cwd = tempDir();
  const conversations = new ConversationService({
    store,
    adapters: { fake: createFakeAdapter() },
    runtimeFor: async () => ({ executablePath: null, env: {} }),
    worktrees: {
      create: async (_cwd, id) => ({ cwd: join(cwd, 'worktrees', id), repoRoot: cwd }),
    },
    gitRun: async () => ({ code: 0, stdout: '', stderr: '' }),
    onEvent: () => {},
    onConversation: () => {},
  });
  const tasks = new TaskService({
    store,
    conversations,
    gitRun: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: Date.now,
    newId: () => `task-${Math.random().toString(36).slice(2)}`,
  });
  const messages = new MessageService({ store, conversations });
  const collab = new CollaborationService({
    conversations,
    tasks,
    messages,
    isHarnessSupported: (harnessId) => harnessId === 'fake' || harnessId === 'codex',
  });
  return { store, conversations, tasks, messages, collab, cwd };
}

async function parentWithGoal(
  conversations: ConversationService,
  cwd: string,
  goal?: string,
): Promise<Conversation> {
  return conversations.create({ harnessId: 'fake', cwd, ...(goal ? { goal } : {}) });
}

function bodies(conversations: ConversationService, id: string) {
  return conversations.events(id, 0).map((event: ConversationEvent) => event.body);
}

describe('CollaborationService', () => {
  it('reports role, goal and acceptance from the task relationship', async () => {
    const { conversations, tasks, collab, cwd } = setup();
    const parent = await parentWithGoal(conversations, cwd, '整理笔记');
    expect(await collab.handlers.read_task_context(parent.id, {})).toEqual({
      role: 'standalone',
      taskId: null,
      goal: '整理笔记',
      acceptance: null,
      status: null,
      children: [],
    });

    const { task, childConversation } = await tasks.delegate({
      conversationId: parent.id,
      goal: '给笔记补上目录',
      acceptance: '目录可跳转',
      harnessId: 'fake',
    });
    expect(await collab.handlers.read_task_context(childConversation.id, {})).toEqual({
      role: 'child',
      taskId: task.id,
      goal: '给笔记补上目录',
      acceptance: '目录可跳转',
      status: 'running',
      children: [],
    });
    // D16: the parent pulls sub-task progress instead of being pushed runs.
    expect(await collab.handlers.read_task_context(parent.id, {})).toMatchObject({
      role: 'parent',
      children: [{ taskId: task.id, goal: '给笔记补上目录', status: 'running', summary: null }],
    });
    expect(await collab.handlers.read_task_context(parent.id, {})).toMatchObject({
      role: 'parent',
      goal: '整理笔记',
    });
  });

  it('delegates a subtask from a tool call', async () => {
    const { conversations, store, collab, cwd } = setup();
    const parent = await parentWithGoal(conversations, cwd);

    const result = (await collab.handlers.delegate(parent.id, {
      goal: '补充测试',
      acceptance: '全部通过',
    })) as { taskId: string; conversationId: string };

    const task = store.getTask(result.taskId) as Task;
    expect(task).toMatchObject({ parentConversationId: parent.id, status: 'running' });
    const child = conversations.get(result.conversationId);
    expect(child.baseCwd).toBe(cwd);
  });

  it('records a child message on both logs and refuses to message from a parent', async () => {
    const { conversations, tasks, collab, cwd } = setup();
    const parent = await parentWithGoal(conversations, cwd);
    const { childConversation } = await tasks.delegate({
      conversationId: parent.id,
      goal: '子任务',
      acceptance: null,
      harnessId: 'fake',
    });

    const result = (await collab.handlers.send_message(childConversation.id, {
      text: '需要先确认登录跳转的规则',
    })) as { messageId: string; state: string };
    expect(result.state).toBe('delivered');

    const outbound = bodies(conversations, childConversation.id).filter(
      (body) => body.type === 'agent.message',
    );
    const inbound = bodies(conversations, parent.id).filter(
      (body) => body.type === 'agent.message',
    );
    expect(outbound).toEqual([
      {
        type: 'agent.message',
        messageId: result.messageId,
        peerConversationId: parent.id,
        direction: 'out',
        text: '需要先确认登录跳转的规则',
      },
    ]);
    expect(inbound).toEqual([
      {
        type: 'agent.message',
        messageId: result.messageId,
        peerConversationId: childConversation.id,
        direction: 'in',
        text: '需要先确认登录跳转的规则',
      },
    ]);

    await expect(
      collab.handlers.send_message(parent.id, { text: '不该成功' }),
    ).rejects.toMatchObject({ code: CollaborationErrorCode.NotASubtask });
  });

  it('lets a child report review or failure exactly once', async () => {
    const { conversations, tasks, store, collab, cwd } = setup();
    const parent = await parentWithGoal(conversations, cwd);
    const { task, childConversation } = await tasks.delegate({
      conversationId: parent.id,
      goal: '子任务',
      acceptance: null,
      harnessId: 'fake',
    });

    expect(
      await collab.handlers.report_result(childConversation.id, {
        summary: '已补齐目录并验证跳转',
        blocked: false,
      }),
    ).toEqual({ taskId: task.id, status: 'review' });
    expect(store.getTask(task.id)?.status).toBe('review');
    expect(
      bodies(conversations, parent.id).filter((body) => body.type === 'task.updated'),
    ).toContainEqual({
      type: 'task.updated',
      taskId: task.id,
      status: 'review',
      summary: '已补齐目录并验证跳转',
    });

    await expect(
      collab.handlers.report_result(childConversation.id, { summary: '再来一次', blocked: false }),
    ).rejects.toMatchObject({ code: 4012 });
  });

  it('records a handoff request but refuses self and unsupported targets', async () => {
    const { conversations, tasks, collab, cwd } = setup();
    const parent = await parentWithGoal(conversations, cwd);
    const { childConversation } = await tasks.delegate({
      conversationId: parent.id,
      goal: '子任务',
      acceptance: null,
      harnessId: 'fake',
    });

    expect(
      await collab.handlers.request_handoff(childConversation.id, {
        toHarnessId: 'codex',
        reason: '这个任务更适合 Codex',
      }),
    ).toEqual({ recorded: true });
    expect(bodies(conversations, childConversation.id)).toContainEqual({
      type: 'handoff.requested',
      toHarnessId: 'codex',
      reason: '这个任务更适合 Codex',
    });

    await expect(
      collab.handlers.request_handoff(childConversation.id, {
        toHarnessId: 'fake',
        reason: 'same harness',
      }),
    ).rejects.toMatchObject({ code: CollaborationErrorCode.SelfHandoff });
    await expect(
      collab.handlers.request_handoff(childConversation.id, {
        toHarnessId: 'pi',
        reason: 'unsupported',
      }),
    ).rejects.toMatchObject({ code: CollaborationErrorCode.HarnessUnsupported });
  });
});
