import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiExtensionService } from './piExtensionService';

const dirs: string[] = [];
function tempHome(settings?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-ext-'));
  dirs.push(dir);
  if (settings !== undefined) {
    mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'agent', 'settings.json'), settings);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

function setup(home: string, opts: { piPath?: string | null; code?: number } = {}) {
  const calls: string[][] = [];
  const service = new PiExtensionService({
    // 'piPath' in opts distinguishes an explicit null from "not passed".
    piPath: async () => ('piPath' in opts ? (opts.piPath ?? null) : '/usr/local/bin/pi'),
    homeDir: home,
    run: async (_exe, args) => {
      calls.push(args);
      return { code: opts.code ?? 0, output: opts.code ? 'boom: network error' : '' };
    },
  });
  return { service, calls };
}

describe('PiExtensionService', () => {
  it('lists user-scope packages from settings.json', async () => {
    const home = tempHome(JSON.stringify({ packages: ['npm:@foo/bar', './local/path'] }));
    const { service } = setup(home);
    expect(await service.list()).toEqual({
      extensions: [{ source: 'npm:@foo/bar' }, { source: './local/path' }],
      piInstalled: true,
    });
  });

  it('missing or malformed settings means an empty list, not an error', async () => {
    expect(await setup(tempHome()).service.list()).toEqual({
      extensions: [],
      piInstalled: true,
    });
    expect(await setup(tempHome('not json')).service.list()).toEqual({
      extensions: [],
      piInstalled: true,
    });
    expect(await setup(tempHome('{"packages":"oops"}')).service.list()).toEqual({
      extensions: [],
      piInstalled: true,
    });
  });

  it('reports piInstalled=false when detection has no path', async () => {
    const home = tempHome('{"packages":[]}');
    const { service } = setup(home, { piPath: null });
    expect((await service.list()).piInstalled).toBe(false);
  });

  it('install and remove go through the pi CLI with an argv array', async () => {
    const home = tempHome(JSON.stringify({ packages: ['npm:@foo/bar'] }));
    const { service, calls } = setup(home);
    await service.install('git:github.com/user/repo');
    expect(await service.remove('npm:@foo/bar')).toBe(true);
    expect(calls).toEqual([
      ['install', 'git:github.com/user/repo'],
      ['remove', 'npm:@foo/bar'],
    ]);
  });

  it('remove of an unknown source is a no-op', async () => {
    const home = tempHome(JSON.stringify({ packages: [] }));
    const { service, calls } = setup(home);
    expect(await service.remove('npm:@nope/nope')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('cli failure surfaces the output tail; missing pi refuses up front', async () => {
    const home = tempHome(JSON.stringify({ packages: ['x'] }));
    await expect(setup(home, { code: 1 }).service.install('x')).rejects.toMatchObject({
      code: 4051,
      message: expect.stringContaining('boom: network error'),
    });
    await expect(setup(home, { piPath: null }).service.install('x')).rejects.toMatchObject({
      code: 4050,
    });
  });
});
