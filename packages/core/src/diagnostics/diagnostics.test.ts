import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, HarnessInfo } from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { exportDiagnostics } from './diagnostics';
import { installLogCapture, recentLogs, resetLogCapture } from './logBuffer';
import { redactHome, redactSecrets } from './redact';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  resetLogCapture();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-diag-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: '调查路由守卫',
  harnessId: 'fake',
  cwd: '/repo',
  isolation: 'direct',
  baseCwd: null,
  externalSessionId: null,
  ownerVersion: 1,
  state: 'idle',
  lastSeq: 0,
  preview: '',
  goal: null,
  fallbackHarnessId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const harness: HarnessInfo = {
  id: 'claude-code',
  displayName: 'Claude Code',
  binaryName: 'claude',
  installed: true,
  executablePath: '/home/tester/.local/bin/claude',
  version: '1.0.0',
  auth: 'authenticated',
  problem: null,
  chatSupported: true,
};

function makeDeps(dir: string, store: Store) {
  return {
    store,
    version: '0.0.1',
    harnesses: () => Promise.resolve([harness]),
    diagnosticsDir: dir,
    maxConcurrentRuns: 3,
    databasePath: join(dir, 'nexus.sqlite'),
    homeDir: '/home/tester',
    now: () => 1_800_000_000_000,
  };
}

describe('redactSecrets', () => {
  it('scrubs token-shaped secrets and counts the hits', () => {
    const key = `sk-ant-${'x'.repeat(40)}`;
    const result = redactSecrets(`key is ${key} and Bearer ${'y'.repeat(30)}`);
    expect(result.text).not.toContain(key);
    expect(result.text).toContain('<redacted>');
    expect(result.secrets).toBe(2);
    expect(result.envKeys).toBe(0);
  });

  it('scrubs .env-style assignments whose name implies a secret', () => {
    const result = redactSecrets('OPENAI_API_KEY=supersecretvalue123\nDEBUG=true');
    expect(result.text).not.toContain('supersecretvalue123');
    expect(result.text).toContain('OPENAI_API_KEY=<redacted>');
    expect(result.text).toContain('DEBUG=true');
    expect(result.envKeys).toBe(1);
  });

  it('leaves ordinary text untouched', () => {
    const result = redactSecrets('普通的一段话，没有任何密钥');
    expect(result.text).toBe('普通的一段话，没有任何密钥');
    expect(result.secrets + result.envKeys).toBe(0);
  });
});

describe('redactHome', () => {
  it('replaces the home directory with ~', () => {
    expect(redactHome('/home/tester/work/repo', '/home/tester')).toBe('~/work/repo');
  });
});

describe('exportDiagnostics', () => {
  it('writes meta, harnesses, config, logs and redacted event logs', async () => {
    const dir = tempDir();
    const store = new Store(':memory:');
    store.insertConversation(conversation());
    const leaked = `sk-ant-${'z'.repeat(40)}`;
    store.appendEvent(
      'c1',
      { type: 'user.message', messageId: 'm1', text: `帮我看看这个 key 为什么无效：${leaked}` },
      {},
      10,
    );
    installLogCapture();
    console.error('nexus: something failed earlier');

    const result = await exportDiagnostics(makeDeps(dir, store));

    expect(result.redactions.events).toBe(1);
    const meta = JSON.parse(readFileSync(join(result.path, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ app: 'nexus', version: '0.0.1', schemaVersion: 6 });

    const events = readFileSync(join(result.path, 'conversations', 'c1.jsonl'), 'utf8');
    expect(events).not.toContain(leaked);
    expect(events).toContain('<redacted>');
    expect(JSON.parse(events.trim())).toMatchObject({ seq: 1, body: { type: 'user.message' } });

    const harnesses = readFileSync(join(result.path, 'harnesses.json'), 'utf8');
    expect(harnesses).not.toContain('/home/tester');
    expect(harnesses).toContain('~/.local/bin/claude');

    expect(readFileSync(join(result.path, 'logs.txt'), 'utf8')).toContain(
      'nexus: something failed earlier',
    );
    expect(readFileSync(join(result.path, 'config.json'), 'utf8')).toContain(
      '"maxConcurrentRuns": 3',
    );
    store.close();
  });

  it('scopes the export to one conversation when asked', async () => {
    const dir = tempDir();
    const store = new Store(':memory:');
    store.insertConversation(conversation());
    store.insertConversation(conversation({ id: 'c2', title: '另一个会话' }));
    store.appendEvent('c1', { type: 'user.message', messageId: 'm1', text: 'one' }, {}, 10);
    store.appendEvent('c2', { type: 'user.message', messageId: 'm2', text: 'two' }, {}, 10);

    const result = await exportDiagnostics(makeDeps(dir, store), 'c2');

    expect(recentLogs()).toBe('');
    const scoped = readFileSync(join(result.path, 'conversations', 'c2.jsonl'), 'utf8');
    expect(scoped).toContain('two');
    expect(() => readFileSync(join(result.path, 'conversations', 'c1.jsonl'), 'utf8')).toThrow();
    store.close();
  });
});
