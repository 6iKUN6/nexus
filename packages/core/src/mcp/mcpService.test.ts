import { describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { McpService, resolveEnvPlaceholders, runtimeKey } from './mcpService';

function setup(env: Record<string, string> = {}) {
  const store = new Store(':memory:');
  let id = 0;
  const service = new McpService({
    store,
    loginEnv: async () => env,
    now: () => 1000,
    newId: () => `srv-${++id}`,
  });
  return { store, service };
}

// Literal ${VAR} strings trip lint/noTemplateCurlyInString; build them.
const ph = (name: string) => `\${${name}}`;

describe('resolveEnvPlaceholders', () => {
  it('resolves exact placeholder values and reports the missing ones by name', () => {
    const result = resolveEnvPlaceholders(
      { KEY: ph('MY_API_KEY'), plain: 'literal', MISSING: ph('NOPE') },
      { MY_API_KEY: 'secret' },
    );
    expect(result.env).toEqual({ KEY: 'secret', plain: 'literal' });
    expect(result.unresolved).toEqual(['NOPE']);
  });

  it('only treats whole-value placeholders as placeholders', () => {
    const result = resolveEnvPlaceholders({ PARTIAL: `prefix-${ph('X')}` }, { X: 'y' });
    expect(result.env.PARTIAL).toBe(`prefix-${ph('X')}`);
    expect(result.unresolved).toEqual([]);
  });
});

describe('McpService', () => {
  it('creates, lists and updates servers; ids and timestamps are server-owned', async () => {
    const { service } = setup();
    const created = await service.upsert({
      name: '文件系统',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: {},
      enabled: true,
    });
    expect(created.id).toBe('srv-1');

    const updated = await service.upsert({
      id: created.id,
      name: '文件系统',
      command: 'npx',
      args: [],
      env: {},
      enabled: false,
    });
    expect(updated.enabled).toBe(false);
    expect(updated.createdAt).toBe(created.createdAt);

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'srv-1', enabled: false, unresolvedEnv: [] });
  });

  it('rejects updating a server that does not exist', async () => {
    const { service } = setup();
    await expect(
      service.upsert({ id: 'nope', name: 'x', command: 'x', args: [], env: {}, enabled: true }),
    ).rejects.toMatchObject({ code: 4040 });
  });

  it('list annotates unresolved placeholder names without exposing values', async () => {
    const { service } = setup({ GITHUB_TOKEN: 'ghp_secret' });
    await service.upsert({
      name: 'github',
      command: 'github-mcp-server',
      args: [],
      env: { TOKEN: ph('GITHUB_TOKEN'), OTHER: ph('MISSING_VAR') },
      enabled: true,
    });
    const [server] = await service.list();
    expect(server?.unresolvedEnv).toEqual(['MISSING_VAR']);
    expect(JSON.stringify(server)).not.toContain('ghp_secret');
  });

  it('runtimeFor resolves env, filters disabled and non-opted-in servers', async () => {
    const { service } = setup({ API_KEY: 'sekret' });
    const a = await service.upsert({
      name: 'a',
      command: 'cmd-a',
      args: ['--x'],
      env: { KEY: ph('API_KEY') },
      enabled: true,
    });
    const b = await service.upsert({
      name: 'b',
      command: 'cmd-b',
      args: [],
      env: {},
      enabled: false,
    });

    expect(await service.runtimeFor([a.id, b.id])).toEqual([
      { key: runtimeKey(a.id), command: 'cmd-a', args: ['--x'], env: { KEY: 'sekret' } },
    ]);
    expect(runtimeKey(a.id)).toMatch(/^nx_[a-zA-Z0-9]{1,8}$/);
  });

  it('removing a server strips it from conversation opt-in lists', async () => {
    const { store, service } = setup();
    const server = await service.upsert({
      name: 'x',
      command: 'x',
      args: [],
      env: {},
      enabled: true,
    });
    store.insertConversation({
      id: 'conv-1',
      title: 't',
      harnessId: 'fake',
      cwd: '/tmp',
      isolation: 'direct',
      baseCwd: null,
      externalSessionId: null,
      ownerVersion: 1,
      state: 'idle',
      lastSeq: 0,
      preview: '',
      goal: null,
      fallbackHarnessId: null,
      enabledMcpIds: [server.id, 'other'],
      createdAt: 1,
      updatedAt: 1,
    });

    expect(service.remove(server.id)).toBe(true);
    expect(store.getConversation('conv-1')?.enabledMcpIds).toEqual(['other']);
    expect(await service.list()).toEqual([]);
  });
});
