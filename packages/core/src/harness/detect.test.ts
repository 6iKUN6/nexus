import { describe, expect, it } from 'vitest';
import { type DetectDeps, detectHarnesses, parseVersion } from './detect';

function deps(files: Record<string, string | Error>, pathValue = '/first:/second'): DetectDeps {
  return {
    pathValue,
    isExecutable: async (file) => file in files,
    runVersion: async (file) => {
      const out = files[file];
      if (out instanceof Error) throw out;
      return out ?? '';
    },
  };
}

describe('harness detection', () => {
  it('parses versions from typical CLI output', () => {
    expect(parseVersion('2.1.319 (Claude Code)')).toBe('2.1.319');
    expect(parseVersion('codex-cli 0.154.0')).toBe('0.154.0');
    expect(parseVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(parseVersion('unknown')).toBeNull();
  });

  it('reports installed, missing and broken harnesses separately', async () => {
    const result = await detectHarnesses(
      deps({
        '/second/claude': '2.1.319 (Claude Code)',
        '/first/codex': 'codex-cli 0.154.0',
        '/first/pi': new Error('spawn EACCES'),
      }),
    );
    const byId = Object.fromEntries(result.map((h) => [h.id, h]));

    expect(byId['claude-code']).toMatchObject({
      installed: true,
      executablePath: '/second/claude',
      version: '2.1.319',
      auth: 'unknown',
      problem: null,
    });
    expect(byId.codex?.version).toBe('0.154.0');
    expect(byId.pi).toMatchObject({ installed: true, version: null });
    expect(byId.pi?.problem).toContain('EACCES');
    expect(byId.dsh).toMatchObject({ installed: false, executablePath: null, problem: null });
  });

  it('prefers the first match on PATH', async () => {
    const result = await detectHarnesses(deps({ '/first/pi': '1.0.0', '/second/pi': '2.0.0' }));
    expect(result.find((h) => h.id === 'pi')?.executablePath).toBe('/first/pi');
  });

  it('flags output without a recognisable version', async () => {
    const result = await detectHarnesses(deps({ '/first/dsh': 'DeepSeek Harness' }));
    const dsh = result.find((h) => h.id === 'dsh');
    expect(dsh).toMatchObject({ installed: true, version: null });
    expect(dsh?.problem).toContain('DeepSeek Harness');
  });
});
