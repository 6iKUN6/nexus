import { describe, expect, it } from 'vitest';
import { extractMarkedEnv, resolveLoginShellEnv } from './loginShellEnv';

const marked = (body: string) => `noise\n__NEXUS_ENV_START__${body}__NEXUS_ENV_END__\nmore`;

describe('extractMarkedEnv', () => {
  it('parses key=value lines and keeps values containing =', () => {
    const env = extractMarkedEnv(marked('A=1\nB_TOKEN=abc=def==\nEMPTY=\nnovalue\n'));
    expect(env).toEqual({ A: '1', B_TOKEN: 'abc=def==', EMPTY: '' });
  });

  it('returns null without markers', () => {
    expect(extractMarkedEnv('A=1')).toBeNull();
    expect(extractMarkedEnv('__NEXUS_ENV_START__A=1')).toBeNull();
  });
});

describe('resolveLoginShellEnv', () => {
  it('lets the login shell win over the process environment', async () => {
    const env = await resolveLoginShellEnv({
      platform: 'darwin',
      run: async () => marked(`FROM_SHELL=yes\nPATH=/login/path`),
    });
    expect(env.FROM_SHELL).toBe('yes');
    expect(env.PATH).toBe('/login/path');
  });

  it('falls back to process.env when the shell fails', async () => {
    const env = await resolveLoginShellEnv({
      platform: 'darwin',
      run: async () => {
        throw new Error('no shell');
      },
    });
    expect(env.FROM_SHELL).toBeUndefined();
  });

  it('skips the shell on win32', async () => {
    let called = false;
    await resolveLoginShellEnv({
      platform: 'win32',
      run: async () => {
        called = true;
        return '';
      },
    });
    expect(called).toBe(false);
  });
});
