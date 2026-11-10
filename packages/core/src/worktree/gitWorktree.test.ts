import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorktreeManager, findRepoRoot, GitError, realGitRun } from './gitWorktree';

/**
 * Integration test against real git (available on every dev machine; no model
 * quota involved). Each test builds a tiny repo in a temp dir.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const git = (args: string[], cwd: string) =>
  realGitRun(['-c', 'user.name=test', '-c', 'user.email=test@nexus.local', ...args], cwd);

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-git-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await git(['init'], dir);
  mkdirSync(join(dir, 'packages/app'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  writeFileSync(join(dir, 'packages/app/index.ts'), 'export {};\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'init'], dir);
  // git reports resolved paths (/var is a symlink to /private/var on macOS).
  return realpathSync(dir);
}

describe('gitWorktree (real git)', () => {
  it('finds the repo root from a subdirectory and reports non-repos as null', async () => {
    const repo = await makeRepo();
    expect(await findRepoRoot(realGitRun, join(repo, 'packages/app'))).toBe(repo);
    const outside = mkdtempSync(join(tmpdir(), 'nexus-notrepo-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    expect(await findRepoRoot(realGitRun, outside)).toBeNull();
  });

  it('creates a detached worktree with the repo content, preserving the subdirectory', async () => {
    const repo = await makeRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'nexus-wts-'));
    cleanups.push(() => rmSync(wtRoot, { recursive: true, force: true }));
    const manager = createWorktreeManager(wtRoot);

    const { cwd, repoRoot } = await manager.create(join(repo, 'packages/app'), 'conv-1');
    expect(repoRoot).toBe(repo);
    expect(cwd).toBe(join(wtRoot, 'conv-1', 'packages/app'));
    // The worktree is a real checkout: content exists, HEAD is detached.
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], join(wtRoot, 'conv-1'));
    expect(head.stdout.trim()).toBe('HEAD');
    // The user's checkout is untouched and not locked.
    const status = await git(['status', '--porcelain'], repo);
    expect(status.code).toBe(0);
  });

  it('refuses a directory that is not a git repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'nexus-plain-'));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    const manager = createWorktreeManager(join(plain, 'wts'));
    await expect(manager.create(plain, 'conv-2')).rejects.toBeInstanceOf(GitError);
  });
});
