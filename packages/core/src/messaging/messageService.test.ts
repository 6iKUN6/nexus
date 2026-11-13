import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '@nexus/adapter-fake';
import type { AgentAdapter, ConversationEvent } from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../conversations/conversationService';
import { Store } from '../store/store';
import { TaskService } from '../tasks/taskService';
import { MessageService } from './messageService';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-messaging-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(adapter: AgentAdapter = createFakeAdapter(), maxConcurrentRuns?: number) {
  const store = new Store(':memory:');
  cleanups.push(() => store.close());
  const cwd = tempDir();
  const events: ConversationEvent[] = [];
  const conversations = new ConversationService({
    store,
    adapters: { fake: adapter },
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    runtimeFor: async () => ({ executablePath: null, env: {} }),
    worktrees: {
      create: async (_cwd, id) => ({ cwd: join(cwd, 'worktrees', id), repoRoot: cwd }),
    },
    gitRun: async () => ({ code: 0, stdout: '', stderr: '' }),
    onEvent: (event) => {
      events.push(event);
      messages.observeEvent(event);
    },
    onConversation: () => {},
  });
  const tasks = new TaskService({
    store,
    conversations,
    now: Date.now,
    newId: () => `task-${Math.random().toString(36).slice(2)}`,
  });
  const messages = new MessageService({
    store,
    conversations,
    newId: (() => {
      let n = 0;
      return () => `m-${++n}`;
    })(),
  });
  return { store, conversations, tasks, messages, events, cwd };
}

async function makePair(deps: ReturnType<typeof setup>) {
  const parent = await deps.conversations.create({ harnessId: 'fake', cwd: deps.cwd });
  const { task, childConversation } = await deps.tasks.delegate({
    conversationId: parent.id,
    goal: '子任务',
    acceptance: null,
    harnessId: 'fake',
  });
  return { parent, task, child: childConversation };
}

const waitFor = (fn: () => boolean) => expect.poll(fn, { timeout: 3000 }).toBe(true);

function states(store: Store) {
  return store.listInflightMessages().map((m) => `${m.id}:${m.state}`);
}

describe('MessageService', () => {
  it('writes first, records both logs, then delivers to the recipient queue', async () => {
    const deps = setup();
    const { parent, task, child } = await makePair(deps);
    const before = deps.events.filter(
      (e) => e.conversationId === parent.id && e.body.type === 'run.started',
    ).length;

    const message = deps.messages.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '需要先确认登录跳转的规则',
      replyTo: null,
    });
    expect(message.state).toBe('delivered');
    expect(message.runId).toBeTruthy();

    // The recipient got the text as a core- prompt that reached its harness.
    const prompts = deps.events
      .filter((e) => e.conversationId === parent.id && e.body.type === 'user.message')
      .map((e) => (e.body as { text: string }).text);
    const prompt = prompts.find((text) => text.includes(message.id));
    expect(prompt).toContain(`core-[协作消息`);
    expect(prompt).toContain('需要先确认登录跳转的规则');
    expect(prompt).toContain(`reply_to="${message.id}"`);

    await waitFor(
      () =>
        deps.events.filter((e) => e.conversationId === parent.id && e.body.type === 'run.started')
          .length > before,
    );
    expect(deps.store.getMessage(message.id)?.state).toBe('consumed');
  });

  it('marks the original message replied when the recipient answers', async () => {
    const deps = setup();
    const { parent, task, child } = await makePair(deps);
    const first = deps.messages.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '问题',
      replyTo: null,
    });
    const reply = deps.messages.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '补充',
      replyTo: first.id,
    });
    expect(deps.store.getMessage(first.id)?.state).toBe('replied');
    expect(deps.store.getMessage(reply.id)?.state).toBe('delivered');

    await expect(() =>
      deps.messages.send({
        senderId: child.id,
        recipientId: parent.id,
        taskId: task.id,
        text: 'x',
        replyTo: 'm-nope',
      }),
    ).toThrowError(/reply_to/);
  });

  it('never delivers the same id twice (insert is the dedupe point)', async () => {
    const deps = setup();
    const { parent, task, child } = await makePair(deps);
    const first = deps.messages.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '同一条',
      replyTo: null,
    });
    // Simulate a retry landing on the same id (as a redelivery would).
    const row = { ...first, state: 'queued' as const };
    const again = deps.store.insertMessage(row);
    expect(again.created).toBe(false);
    const prompts = deps.events
      .filter((e) => e.conversationId === parent.id && e.body.type === 'user.message')
      .map((e) => (e.body as { text: string }).text)
      .filter((text) => text.includes(first.id));
    expect(prompts).toHaveLength(1);
  });

  it('moves a delivered-but-never-started message to needs_check on cancel, then resends', async () => {
    // The child occupies the only global run slot (permission wait), so the
    // message to the parent is delivered to its queue but never starts.
    const deps = setup(
      createFakeAdapter({ script: () => [{ kind: 'permission', description: '等一下' }] }),
      1,
    );
    const { parent, task, child } = await makePair(deps);
    await waitFor(() =>
      deps.events.some((e) => e.conversationId === child.id && e.body.type === 'run.started'),
    );
    const message = deps.messages.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '这条会在排队时被取消',
      replyTo: null,
    });
    expect(message.state).toBe('delivered');
    expect(
      deps.events.some(
        (e) =>
          e.conversationId === parent.id &&
          e.body.type === 'run.started' &&
          e.body.runId === message.runId,
      ),
    ).toBe(false);

    const cancelled = await deps.conversations.cancel(parent.id);
    expect(cancelled).toBe(true);
    // Never reached the model: the outcome is uncertain and must be reviewed.
    expect(deps.store.getMessage(message.id)?.state).toBe('needs_check');

    const resent = deps.messages.resend(message.id);
    expect(resent.state).toBe('delivered');
    expect(resent.id).toBe(message.id);
    await expect(() => deps.messages.resend(message.id)).toThrowError(/重发/);
  });

  it('reconciles inflight messages to needs_check after a restart', async () => {
    const deps = setup();
    const { parent, task, child } = await makePair(deps);
    const message = deps.messages.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '重启前发出',
      replyTo: null,
    });
    expect(states(deps.store)).toEqual([`${message.id}:delivered`]);

    deps.messages.reconcile();
    expect(deps.store.getMessage(message.id)?.state).toBe('needs_check');
    expect(states(deps.store)).toEqual([]);
  });

  it('marks delivery failed when the recipient cannot take the prompt', async () => {
    const deps = setup();
    const { parent, task, child } = await makePair(deps);
    // A recipient conversation that exists (FK) but whose send throws.
    const broken = new MessageService({
      store: deps.store,
      conversations: {
        get: deps.conversations.get.bind(deps.conversations),
        recordCollaborationEvent: deps.conversations.recordCollaborationEvent.bind(
          deps.conversations,
        ),
        send: () => {
          throw new Error('recipient is gone');
        },
      } as unknown as ConversationService,
    });
    const message = broken.send({
      senderId: child.id,
      recipientId: parent.id,
      taskId: task.id,
      text: '对方已经不在了',
      replyTo: null,
    });
    expect(message.state).toBe('failed');
    expect(deps.store.getMessage(message.id)?.state).toBe('failed');
  });
});
