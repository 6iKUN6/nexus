import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitRun } from '../worktree/gitWorktree';
import { collectTaskEvidence } from './evidence';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-evidence-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Canned git outputs keyed by subcommand. */
function fakeGit(outputs: Record<string, { code: number; stdout: string }>): GitRun {
  return async (args) => {
    const key = args.slice(0, 2).join(' ');
    const hit = outputs[key] ?? outputs[args[0] ?? ''];
    return hit ? { ...hit, stderr: '' } : { code: 128, stdout: '', stderr: 'unknown' };
  };
}

describe('collectTaskEvidence', () => {
  it('combines numstat and porcelain into file-level evidence, hiding secrets', async () => {
    const cwd = tempDir();
    const run = fakeGit({
      'rev-parse HEAD': { code: 0, stdout: 'abc123\n' },
      'status --porcelain': {
        code: 0,
        stdout: ' M src/a.ts\0 D old.txt\0?? notes.md\0?? .env\0',
      },
      'diff HEAD': { code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n+hello\n' },
      // numstat is a separate call; key by its first three args.
    });
    const withNumstat: GitRun = async (args) => {
      if (args.join(' ').startsWith('diff HEAD --numstat')) {
        return { code: 0, stdout: '3\t1\tsrc/a.ts\x00\t5\told.txt\0', stderr: '' };
      }
      return run(args, cwd);
    };

    const evidence = await collectTaskEvidence(withNumstat, cwd);
    expect(evidence.available).toBe(true);
    expect(evidence.baseCommit).toBe('abc123');
    expect(evidence.files).toEqual([
      { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1 },
      { path: 'old.txt', status: 'deleted', added: 0, deleted: 5 },
    ]);
    expect(evidence.untracked).toEqual(['notes.md']);
    expect(evidence.secretFilesOmitted).toBe(1);
    expect(evidence.diff).toContain('diff --git');
    expect(evidence.diffTruncated).toBe(false);
  });

  it('is unavailable when the worktree is gone or not a repository', async () => {
    const gone = await collectTaskEvidence(fakeGit({}), join(tmpdir(), 'nexus-no-such-dir'));
    expect(gone).toMatchObject({ available: false, files: [], untracked: [] });

    const cwd = tempDir();
    const notRepo = await collectTaskEvidence(fakeGit({}), cwd);
    expect(notRepo.available).toBe(false);
    expect(notRepo.problem).toContain('不是 git 仓库');
  });

  it('reports a clean worktree as empty evidence', async () => {
    const cwd = tempDir();
    const run: GitRun = async (args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc123\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const evidence = await collectTaskEvidence(run, cwd);
    expect(evidence).toMatchObject({
      available: true,
      files: [],
      untracked: [],
      secretFilesOmitted: 0,
      diff: null,
      diffTruncated: false,
    });
  });
});
