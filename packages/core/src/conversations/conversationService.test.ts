import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter, type FakeStep } from '@nexus/adapter-fake';
import type {
  AdapterSession,
  AgentAdapter,
  Conversation,
  ConversationEvent,
} from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { GitError } from '../worktree/gitWorktree';
import { ConversationService, ErrorCode } from './conversationService';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDb(): string {
  return join(tempDir(), 'nexus.sqlite');
}

/** A fresh working directory (direct conversations are one-per-directory). */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-core-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(
  adapter: AgentAdapter = createFakeAdapter(),
  dbPath = ':memory:',
  worktreeCreate?: (cwd: string, id: string) => Promise<{ cwd: string; repoRoot: string }>,
  maxConcurrentRuns?: number,
) {
  const store = new Store(dbPath);
  const events: ConversationEvent[] = [];
  const updates: Conversation[] = [];
  const worktreeCalls: Array<{ cwd: string; id: string }> = [];
  let id = 0;
  const service = new ConversationService({
    store,
    adapters: { fake: adapter },
    runtimeFor: async () => ({ executablePath: null, env: {} }),
    worktrees: {
      create: async (cwd, cid) => {
        worktreeCalls.push({ cwd, id: cid });
        return worktreeCreate?.(cwd, cid) ?? { cwd: join(cwd, '.nexus-wt', cid), repoRoot: cwd };
      },
    },
    gitRun: async () => ({ code: 0, stdout: '', stderr: '' }),
    onEvent: (e) => events.push(e),
    onConversation: (c) => updates.push(c),
    newId: () => `id-${++id}`,
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
  });
  return { store, service, events, updates, worktreeCalls };
}

const types = (events: ConversationEvent[]) => events.map((e) => e.body.type);
const waitFor = (fn: () => boolean) => expect.poll(fn, { timeout: 2000 }).toBe(true);

describe('ConversationService', () => {
  it('validates harness support and the working directory on create', async () => {
    const { service } = setup();
    await expect(service.create({ harnessId: 'codex', cwd: tmpdir() })).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
    });
    await expect(
      service.create({ harnessId: 'fake', cwd: '/definitely/not/here' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidCwd });
  });

  it('persists every event with consecutive seqs and derives title, state and preview', async () => {
    const { service, events } = setup();
    const c = await service.create({ harnessId: 'fake', cwd: tmpdir() });
    service.send(c.id, '帮我看看  登录跳转的问题');
    await waitFor(() => events.at(-1)?.body.type === 'run.completed');

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(service.events(c.id, 0)).toEqual(events);
    expect(service.events(c.id, 3).map((e) => e.seq)[0]).toBe(4);

    const [saved] = service.list();
    expect(saved).toMatchObject({
      title: '帮我看看 登录跳转的问题',
      state: 'idle',
      externalSessionId: expect.stringMatching(/^fake-/),
      lastSeq: events.length,
    });
    expect(saved?.preview).toContain('收到');
  });

  it('queues prompts while a run is active and runs them in order', async () => {
    const { service, events } = setup(
      createFakeAdapter({ script: (p) => [{ kind: 'text', text: `re:${p}` }], stepDelayMs: 20 }),
    );
    const c = await service.create({ harnessId: 'fake', cwd: tmpdir() });
    const first = service.send(c.id, 'one');
    const second = service.send(c.id, 'two');
    expect(first.queued).toBe(false);
    expect(second.queued).toBe(true);
    await waitFor(() => types(events).filter((t) => t === 'run.completed').length === 2);

    const runOrder = events.flatMap((e) => (e.body.type === 'run.started' ? [e.body.runId] : []));
    expect(runOrder).toEqual([first.runId, second.runId]);
    expect(types(events)).toContain('run.queued');
    const texts = events.flatMap((e) => (e.body.type === 'text.delta' ? [e.body.text] : []));
    expect(texts).toEqual(['re:one', 're:two']);
  });

  it('caps concurrent runs across conversations and starts queued ones in order', async () => {
    const { service, events } = setup(
      createFakeAdapter({ script: (p) => [{ kind: 'text', text: `done:${p}` }], stepDelayMs: 200 }),
      ':memory:',
      undefined,
      1,
    );
    const a = await service.create({ harnessId: 'fake', cwd: tempDir() });
    const b = await service.create({ harnessId: 'fake', cwd: tempDir() });
    const first = service.send(a.id, 'a1');
    const second = service.send(b.id, 'b1');
    expect(first.queued).toBe(false);
    // The cap is reached, so this prompt waits even though its conversation is idle.
    expect(second.queued).toBe(true);
    // b waits while a holds the only slot: its run has not started.
    expect(events.some((e) => e.body.type === 'run.started' && e.body.runId === second.runId)).toBe(
      false,
    );
    expect(service.get(b.id).state).toBe('idle');

    await waitFor(() => types(events).filter((t) => t === 'run.completed').length === 2);
    const started = events.flatMap((e) => (e.body.type === 'run.started' ? [e.body.runId] : []));
    expect(started).toEqual([first.runId, second.runId]);
    expect(service.get(b.id).state).toBe('idle');
  });

  it('cancels a run that is still waiting for a global slot', async () => {
    const { service, events } = setup(
      createFakeAdapter({ stepDelayMs: 40 }),
      ':memory:',
      undefined,
      1,
    );
    const a = await service.create({ harnessId: 'fake', cwd: tempDir() });
    const b = await service.create({ harnessId: 'fake', cwd: tempDir() });
    service.send(a.id, 'a1');
    const waiting = service.send(b.id, 'b1');
    expect(waiting.queued).toBe(true);

    await expect(service.cancel(b.id)).resolves.toBe(true);
    const endOfB = events.findLast(
      (e) => e.conversationId === b.id && e.body.type === 'run.completed',
    )?.body;
    expect(endOfB).toMatchObject({ runId: waiting.runId, stopReason: 'cancelled' });

    // The slot goes back to the pool: a new prompt in b starts normally.
    await waitFor(() =>
      events.some((e) => e.conversationId === a.id && e.body.type === 'run.completed'),
    );
    const next = service.send(b.id, 'b2');
    await waitFor(() =>
      events.some(
        (e) =>
          e.conversationId === b.id && e.body.type === 'run.started' && e.body.runId === next.runId,
      ),
    );
    expect(next.queued).toBe(false);
  });

  it('routes permission answers to the adapter and records them', async () => {
    const script: FakeStep[] = [
      { kind: 'permission', description: '写入 a.txt' },
      { kind: 'text', text: 'done' },
    ];
    const { service, events, updates } = setup(createFakeAdapter({ script }));
    const c = await service.create({ harnessId: 'fake', cwd: tmpdir() });
    service.send(c.id, 'go');
    await waitFor(() => events.some((e) => e.body.type === 'permission.requested'));
    expect(updates.at(-1)?.state).toBe('waiting_user');

    const request = events.find((e) => e.body.type === 'permission.requested')?.body;
    if (request?.type !== 'permission.requested') throw new Error('no request');
    await service.respondToPermission(c.id, request.requestId, 'allow');
    await waitFor(() => events.at(-1)?.body.type === 'run.completed');

    expect(types(events)).toContain('permission.resolved');
    await expect(
      service.respondToPermission(c.id, request.requestId, 'allow'),
    ).rejects.toMatchObject({
      code: ErrorCode.PermissionExpired,
    });
  });

  it('cancels the active run only', async () => {
    const { service, events } = setup(
      createFakeAdapter({
        script: Array.from({ length: 40 }, () => ({ kind: 'text' as const, text: '.' })),
        stepDelayMs: 10,
      }),
    );
    const a = await service.create({ harnessId: 'fake', cwd: tmpdir() });
    // Same directory only allows one direct conversation; b uses a worktree.
    const b = await service.create({ harnessId: 'fake', cwd: tmpdir(), isolation: 'worktree' });
    service.send(a.id, 'x');
    service.send(b.id, 'y');
    await waitFor(() => events.filter((e) => e.body.type === 'text.delta').length > 4);
    await expect(service.cancel(a.id)).resolves.toBe(true);

    await waitFor(() =>
      events.some((e) => e.conversationId === a.id && e.body.type === 'run.completed'),
    );
    const endOf = (id: string) =>
      events.filter((e) => e.conversationId === id && e.body.type === 'run.completed').at(-1)?.body;
    expect(endOf(a.id)).toMatchObject({ stopReason: 'cancelled' });
    await waitFor(() => endOf(b.id) !== undefined);
    expect(endOf(b.id)).toMatchObject({ stopReason: 'end_turn' });
    await expect(service.cancel(a.id)).resolves.toBe(false);
  });

  it('closes a stream that ends without a terminal event as failed (result unknown)', async () => {
    const adapter: AgentAdapter = {
      ...createFakeAdapter(),
      async createSession(): Promise<AdapterSession> {
        return {
          externalId: 'x',
          async *sendPrompt({ runId }) {
            yield { type: 'run.started', runId };
          },
          async cancel() {},
          async dispose() {
            return { confirmed: true, problem: null };
          },
        };
      },
    };
    const { service, events } = setup(adapter);
    const c = await service.create({ harnessId: 'fake', cwd: tmpdir() });
    service.send(c.id, 'go');
    await waitFor(() => events.at(-1)?.body.type === 'run.failed');
    expect(events.at(-1)?.body).toMatchObject({ error: { code: 'no_terminal_event' } });
  });

  it('after a restart, marks interrupted runs failed and never re-runs them', async () => {
    const dbPath = tempDb();
    const first = setup(
      createFakeAdapter({ script: [{ kind: 'permission', description: 'x' }] }),
      dbPath,
    );
    const c = await first.service.create({ harnessId: 'fake', cwd: tmpdir() });
    first.service.send(c.id, 'one');
    first.service.send(c.id, 'two (queued)');
    await waitFor(() => first.events.some((e) => e.body.type === 'permission.requested'));
    first.store.close(); // simulated crash: no dispose, nothing finished

    let sessionsCreated = 0;
    const counting = createFakeAdapter();
    const second = setup(
      {
        ...counting,
        createSession: (o) => {
          sessionsCreated++;
          return counting.createSession(o);
        },
      },
      dbPath,
    );
    expect(second.service.recoverInterruptedRuns()).toBe(2);
    const history = second.service.events(c.id, 0);
    const failures = history.filter((e) => e.body.type === 'run.failed');
    expect(failures.map((e) => e.body.type === 'run.failed' && e.body.error.code)).toEqual([
      'interrupted',
      'interrupted',
    ]);
    expect(second.service.list()[0]?.state).toBe('failed');
    expect(sessionsCreated).toBe(0);
    expect(second.service.recoverInterruptedRuns()).toBe(0);
  });

  it('resumes the stored harness session after a restart', async () => {
    const dbPath = tempDb();
    const first = setup(createFakeAdapter(), dbPath);
    const c = await first.service.create({ harnessId: 'fake', cwd: tmpdir() });
    first.service.send(c.id, 'hi');
    await waitFor(() => first.events.at(-1)?.body.type === 'run.completed');
    const externalId = first.service.list()[0]?.externalSessionId;
    await first.service.dispose();
    first.store.close();

    const resumed: string[] = [];
    const base = createFakeAdapter();
    const second = setup(
      {
        ...base,
        resumeSession: async (id, o) => {
          resumed.push(id);
          return base.createSession(o);
        },
      },
      dbPath,
    );
    second.service.send(c.id, 'again');
    await waitFor(() => second.events.at(-1)?.body.type === 'run.completed');
    expect(resumed).toEqual([externalId]);
  });
});

describe('isolation (ADR 0006)', () => {
  it('creates a worktree conversation running in the worktree, remembering baseCwd', async () => {
    const { service, worktreeCalls } = setup();
    const c = await service.create({ harnessId: 'fake', cwd: tmpdir(), isolation: 'worktree' });
    expect(worktreeCalls).toEqual([{ cwd: tmpdir(), id: c.id }]);
    expect(c).toMatchObject({
      isolation: 'worktree',
      baseCwd: tmpdir(),
      cwd: join(tmpdir(), '.nexus-wt', c.id),
    });
    expect(service.list()[0]).toMatchObject({ isolation: 'worktree', baseCwd: tmpdir() });
  });

  it('maps a non-repo worktree request to NotARepo', async () => {
    const { service } = setup(createFakeAdapter(), ':memory:', async () => {
      throw new GitError(`不是 git 仓库：${tmpdir()}`);
    });
    await expect(
      service.create({ harnessId: 'fake', cwd: tmpdir(), isolation: 'worktree' }),
    ).rejects.toMatchObject({ code: ErrorCode.NotARepo });
    expect(service.list()).toHaveLength(0);
  });

  it('rejects a second direct conversation on the same cwd but allows a worktree one', async () => {
    const { service } = setup();
    await service.create({ harnessId: 'fake', cwd: tmpdir() });
    await expect(service.create({ harnessId: 'fake', cwd: tmpdir() })).rejects.toMatchObject({
      code: ErrorCode.CwdInUse,
    });
    await expect(service.create({ harnessId: 'fake', cwd: `${tmpdir()}/` })).rejects.toMatchObject({
      code: ErrorCode.CwdInUse,
    });
    const c = await service.create({ harnessId: 'fake', cwd: tmpdir(), isolation: 'worktree' });
    expect(c.isolation).toBe('worktree');
  });

  it('inspectPath reports existence, repo root and direct usage', async () => {
    const { service } = setup();
    const missing = await service.inspectPath('/definitely/not/here');
    expect(missing).toEqual({
      exists: false,
      isGitRepo: false,
      repoRoot: null,
      directInUse: false,
    });
    await service.create({ harnessId: 'fake', cwd: tmpdir() });
    const used = await service.inspectPath(tmpdir());
    expect(used).toMatchObject({ exists: true, directInUse: true });
  });
});
