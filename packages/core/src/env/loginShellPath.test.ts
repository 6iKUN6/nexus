import { describe, expect, it } from 'vitest';
import { extractMarkedPath, mergePathValues, resolveLoginShellPath } from './loginShellPath';

describe('login shell PATH', () => {
  it('extracts the marked PATH even when rc files print noise', () => {
    const output = 'Welcome!\n__NEXUS_PATH_START__/a:/b__NEXUS_PATH_END__\n';
    expect(extractMarkedPath(output)).toBe('/a:/b');
    expect(extractMarkedPath('no markers here')).toBeNull();
  });

  it('merges PATH values in order without duplicates', () => {
    expect(mergePathValues('/a:/b', null, '/b:/c', '')).toBe('/a:/b:/c');
  });

  it('puts the login shell PATH first', async () => {
    const result = await resolveLoginShellPath({
      shell: '/bin/zsh',
      currentPath: '/usr/bin',
      platform: 'darwin',
      run: async () => '__NEXUS_PATH_START__/nvm/bin:/usr/bin__NEXUS_PATH_END__',
    });
    expect(result.split(':').slice(0, 2)).toEqual(['/nvm/bin', '/usr/bin']);
    expect(result).toContain('/opt/homebrew/bin');
  });

  it('falls back to the current PATH when the shell fails', async () => {
    const result = await resolveLoginShellPath({
      currentPath: '/usr/bin',
      platform: 'darwin',
      run: async () => {
        throw new Error('timeout');
      },
    });
    expect(result.startsWith('/usr/bin')).toBe(true);
  });
});
