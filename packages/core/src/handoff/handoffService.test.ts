import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter, type FakeStep } from '@nexus/adapter-fake';
import {
  type AgentAdapter,
  type Conversation,
  type ConversationEvent,
  createMemoryPortPair,
  createRpcClient,
  type RpcClient,
} from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../core';
import type { GitRun } from '../worktree/gitWorktree';

/**
 * Handoff (M4) through the core RPC surface: the source is stopped (verified),
 * the package is frozen for review, then ownership changes in one step. Git is
 * faked; what matters here is the state machine and the ownership guarantee.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-handoff-'));
  dirs.push(dir);
  return dir;
}

const cleanGit: GitRun = async (args) => {
  if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc123\n', stderr: '' };
  if (args[0] === 'status') return { code: 0, stdout: '?? notes.md\0?? .env.local\0', stderr: '' };
  if (args[0] === 'diff') return { code: 0, stdout: 'diff --git a/x b/x\n+改了\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

/** A second harness whose "process" cannot be confirmed stopped. */
function unverifiableAdapter(): AgentAdapter {
  return {
    harnessId: 'codex',
    probe: createFakeAdapter().probe,
    createSession: async () => {
      const session = await createFakeAdapter().createSession({
        cwd: '/',
        executablePath: null,
        env: {},
      });
      return { ...session, dispose: async () => ({ confirmed: false, problem: '进程仍在' }) };
    },
  };
}

function connect(options: {
  script?: (prompt: string) => FakeStep[];
  databasePath?: string;
  codex?: AgentAdapter;
  gitRun?: GitRun;
}) {
  const core = createCore({
    version: '0.0.0-test',
    databasePath: options.databasePath ?? ':memory:',
    adapters: {
      fake: createFakeAdapter({ script: options.script ?? replyScript }),
      codex: options.codex ?? createFakeAdapter({ script: options.script ?? replyScript }),
    },
    detectHarnesses: async () => [],
    resolvePath: async () => '/bin',
    worktrees: {
      create: async (cwd, id) => ({ cwd: join(cwd, '.fake-worktrees', id), repoRoot: cwd }),
    },
    gitRun: options.gitRun ?? cleanGit,
  });
  const [clientPort, corePort] = createMemoryPortPair();
  core.attach(corePort);
  const pushed: ConversationEvent[] = [];
  const client = createRpcClient(clientPort);
  client.onNotification('conversation.event', (event) => pushed.push(event));
  return { core, client, pushed };
}

const replyScript = (prompt: string): FakeStep[] => [{ kind: 'text', text: `收到：${prompt}` }];

async function createConversation(client: RpcClient): Promise<Conversation> {
  const { conversation } = await client.request('conversation.create', {
    harnessId: 'fake',
    cwd: repoDir(),
    isolation: 'direct',
  });
  return conversation;
}

async function waitFor(predicate: () => boolean, timeout = 5000) {
  await expect.poll(predicate, { timeout, interval: 10 }).toBe(true);
}

const prepare = (
  client: RpcClient,
  conversationId: string,
  toHarnessId: Conversation['harnessId'] = 'codex',
) =>
  client.request('handoff.prepare', {
    conversationId,
    toHarnessId,
    goal: '修好登录后的跳转',
    nextAction: '先运行已记录的复现步骤',
    facts: ['问题出在回调里'],
    assumptions: [],
  });

describe('handoff (M4)', () => {
  it('prepares a traceable package, then commits ownership in one step', async () => {
    const { client } = connect({});
    const conversation = await createConversation(client);
    const events: ConversationEvent[] = [];
    client.onNotification('conversation.event', (event) => events.push(event));
    await client.request('conversation.send', {
      conversationId: conversation.id,
      text: '保持现有登录接口兼容',
    });
    await waitFor(() => events.some((e) => e.body.type === 'run.completed'));

    const { handoff } = await prepare(client, conversation.id);
    expect(handoff.state).toBe('prepared');
    const pkg = handoff.package;
    expect(pkg).not.toBeNull();
    if (!pkg) throw new Error('no package');
    expect(pkg.userRequirements.map((r) => r.text)).toEqual(['保持现有登录接口兼容']);
    expect(pkg.confirmedFacts.some((f) => f.includes('问题出在回调里'))).toBe(true);
    // Workspace: base commit + diff + untracked list, with secrets withheld.
    expect(pkg.workspace).toMatchObject({ baseCommit: 'abc123', untrackedFiles: ['notes.md'] });
    expect(pkg.workspace.dirtyDiff).toContain('+改了');
    expect(pkg.omitted.some((o) => o.item.includes('.env.local'))).toBe(true);
    expect(pkg.estimatedTokens).toBeGreaterThan(0);
    // The owner has not changed yet.
    const before = (await client.request('conversation.list', {})).conversations[0];
    expect(before).toMatchObject({ harnessId: 'fake', ownerVersion: 1 });

    const { handoff: committed, conversation: handed } = await client.request('handoff.commit', {
      handoffId: handoff.id,
      version: handoff.version,
    });
    expect(committed.state).toBe('committed');
    expect(handed).toMatchObject({ harnessId: 'codex', ownerVersion: 2, externalSessionId: null });

    // The receiver gets the brief first, then runs under the new owner.
    const handoffEvent = events.find((e) => e.body.type === 'handoff');
    expect(handoffEvent?.body).toMatchObject({ state: 'committed', toHarnessId: 'codex' });
    const briefIndex = events.findIndex(
      (e) => e.body.type === 'user.message' && e.body.text.includes('上一任 Agent 已停止'),
    );
    expect(briefIndex).toBeGreaterThan(handoffEvent ? events.indexOf(handoffEvent) : -1);
    // The receiver starts a run *from the brief*: run.started comes after it.
    await waitFor(() => {
      const started = events.findLast((e) => e.body.type === 'run.started');
      return started !== undefined && started.seq > (events[briefIndex]?.seq ?? Infinity);
    });
    await waitFor(() => {
      const afterBrief = events.slice(briefIndex);
      return afterBrief.some((e) => e.body.type === 'run.completed');
    });
  });

  it('blocks the handoff when the source process cannot be verified stopped', async () => {
    const { client, pushed } = connect({ codex: unverifiableAdapter() });
    // The conversation must be on the *codex* adapter to make its stop fail.
    const { conversation } = await client.request('conversation.create', {
      harnessId: 'codex',
      cwd: repoDir(),
      isolation: 'direct',
    });
    await client.request('conversation.send', { conversationId: conversation.id, text: '开始' });
    await waitFor(() => pushed.some((e) => e.body.type === 'run.completed'));

    await expect(prepare(client, conversation.id, 'fake')).rejects.toMatchObject({ code: 4014 });
    const listed = (await client.request('conversation.list', {})).conversations[0];
    expect(listed).toMatchObject({ harnessId: 'codex', ownerVersion: 1 });
    const abort = pushed.find((e) => e.body.type === 'handoff');
    expect(abort?.body).toMatchObject({ state: 'aborted' });

    // The hold must be released: a blocked handoff may not freeze the conversation.
    const sent = await client.request('conversation.send', {
      conversationId: conversation.id,
      text: '继续',
    });
    expect(sent.queued).toBe(false);
    await waitFor(() => pushed.filter((e) => e.body.type === 'run.started').length >= 2);
  });

  it('rejects a stale commit version and leaves the owner unchanged', async () => {
    const { client } = connect({});
    const conversation = await createConversation(client);
    const { handoff } = await prepare(client, conversation.id);
    await expect(
      client.request('handoff.commit', { handoffId: handoff.id, version: handoff.version + 5 }),
    ).rejects.toMatchObject({ code: 4015 });
    const listed = (await client.request('conversation.list', {})).conversations[0];
    expect(listed).toMatchObject({ harnessId: 'fake', ownerVersion: 1 });
  });

  it('holds new prompts while a handoff is under review, then runs them under the new owner', async () => {
    const { client } = connect({});
    const conversation = await createConversation(client);
    const { handoff } = await prepare(client, conversation.id);
    const { queued } = await client.request('conversation.send', {
      conversationId: conversation.id,
      text: '交接期间写下的消息',
    });
    expect(queued).toBe(true);
    // Nothing may run while the owner is still the old harness.
    const { handoff: committed } = await client.request('handoff.commit', {
      handoffId: handoff.id,
      version: handoff.version,
    });
    await waitFor(() => committed.state === 'committed');
    await expect
      .poll(
        async () => {
          const { events } = await client.request('conversation.events', {
            conversationId: conversation.id,
          });
          return events.filter((e) => e.body.type === 'run.completed').length;
        },
        { timeout: 5000 },
      )
      .toBe(2); // the brief and the held prompt
  });

  it('cancel drops the package and leaves the original owner in charge', async () => {
    const { client } = connect({});
    const conversation = await createConversation(client);
    const { handoff } = await prepare(client, conversation.id);
    const { handoff: cancelled } = await client.request('handoff.cancel', {
      handoffId: handoff.id,
    });
    expect(cancelled).toMatchObject({ state: 'aborted', problem: '用户取消了交接' });
    // The hold is released: a prompt runs again.
    await client.request('conversation.send', { conversationId: conversation.id, text: '继续' });
    await expect
      .poll(
        async () => {
          const { events } = await client.request('conversation.events', {
            conversationId: conversation.id,
          });
          return events.some((e) => e.body.type === 'run.completed');
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const [listed] = (await client.request('conversation.list', {})).conversations;
    expect(listed?.harnessId).toBe('fake');
  });

  it('after a restart, a prepared handoff is aborted and the original owner stays', async () => {
    const dbPath = join(repoDir(), 'nexus.sqlite');
    const first = connect({ databasePath: dbPath });
    const conversation = await createConversation(first.client);
    await prepare(first.client, conversation.id);
    await first.core.dispose();

    const second = connect({ databasePath: dbPath });
    const listed = (await second.client.request('conversation.list', {})).conversations[0];
    expect(listed).toMatchObject({ harnessId: 'fake', ownerVersion: 1 });
    await expect
      .poll(
        async () => {
          const { events } = await second.client.request('conversation.events', {
            conversationId: conversation.id,
          });
          return events.find((e) => e.body.type === 'handoff')?.body;
        },
        { timeout: 5000 },
      )
      .toMatchObject({ state: 'aborted' });
    await second.core.dispose();
  });

  it('after a restart, a committed handoff keeps the receiver and asks for the user', async () => {
    const dbPath = join(repoDir(), 'nexus.sqlite');
    const first = connect({ databasePath: dbPath });
    const conversation = await createConversation(first.client);
    const { handoff } = await prepare(first.client, conversation.id);
    await first.client.request('handoff.commit', {
      handoffId: handoff.id,
      version: handoff.version,
    });
    await first.core.dispose();

    const second = connect({ databasePath: dbPath });
    const listed = (await second.client.request('conversation.list', {})).conversations[0];
    expect(listed).toMatchObject({ harnessId: 'codex', ownerVersion: 2 });
    await expect
      .poll(
        async () => {
          const { events } = await second.client.request('conversation.events', {
            conversationId: conversation.id,
          });
          return events.findLast((e) => e.body.type === 'handoff')?.body;
        },
        { timeout: 5000 },
      )
      .toMatchObject({ state: 'needs_reconciliation' });
    await second.core.dispose();
  });
});
