import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Git worktree management (ADR 0006). Worktrees live in the app data
 * directory (`<worktreeRoot>/<conversationId>`), added with a detached HEAD:
 * no branch pollution, the user's checkout is never touched.
 *
 * All git invocations use argv arrays, never shell strings. The runner is
 * injectable so tests don't need git.
 */

export type GitRun = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realGitRun: GitRun = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A numeric code means git ran and failed; anything else (ENOENT…) is
        // the spawn itself failing, which callers should see as an exception.
        if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });

export class GitError extends Error {}

/** Absolute path of the repository containing `cwd`, or null when not a repo. */
export async function findRepoRoot(run: GitRun, cwd: string): Promise<string | null> {
  const result = await run(['rev-parse', '--show-toplevel'], cwd);
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  return root || null;
}

/** Longest diff kept in a handoff package; larger ones are truncated and flagged. */
const MAX_DIFF_CHARS = 12_000;

const SECRET_FILE = /(^|\/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$)/;

/**
 * Working-state snapshot for a handoff (ADR 0011). The receiver works in the
 * same directory, so this is a record of what it inherits — not a patch to
 * re-apply — and it is captured *before* ownership changes.
 */
export async function captureWorkspace(
  run: GitRun,
  cwd: string,
): Promise<{
  workspace: {
    root: string;
    baseCommit: string | null;
    dirtyDiff: string | null;
    untrackedFiles: string[];
  };
  truncatedDiff: boolean;
  secretFiles: string[];
}> {
  const head = await run(['rev-parse', 'HEAD'], cwd);
  const baseCommit = head.code === 0 ? head.stdout.trim() || null : null;
  const status = await run(['status', '--porcelain', '-z'], cwd);
  // -z entries are "XY path\0" (renames add a second NUL-separated path).
  const untracked: string[] = [];
  if (status.code === 0) {
    for (const entry of status.stdout.split('\0')) {
      if (entry.startsWith('?? ')) untracked.push(entry.slice(3));
    }
  }
  const diff = await run(['diff', 'HEAD'], cwd);
  const dirty = diff.code === 0 ? diff.stdout : '';
  const truncatedDiff = dirty.length > MAX_DIFF_CHARS;
  const secretFiles = untracked.filter((file) => SECRET_FILE.test(file));
  return {
    workspace: {
      root: cwd,
      baseCommit,
      dirtyDiff: dirty.trim() ? dirty.slice(0, MAX_DIFF_CHARS) : null,
      untrackedFiles: untracked.filter((file) => !SECRET_FILE.test(file)),
    },
    truncatedDiff,
    secretFiles,
  };
}

export type WorktreeManager = {
  /** Creates `<worktreeRoot>/<id>` as a detached worktree of cwd's repo and
   * returns the directory the conversation should actually run in (keeps the
   * relative subdirectory when cwd was below the repo root). */
  create(cwd: string, id: string): Promise<{ cwd: string; repoRoot: string }>;
};

export function createWorktreeManager(
  worktreeRoot: string,
  run: GitRun = realGitRun,
): WorktreeManager {
  return {
    async create(cwd, id) {
      const info = await stat(cwd).catch(() => null);
      if (!info?.isDirectory()) throw new GitError(`工作目录不存在：${cwd}`);
      // git reports resolved paths; resolve cwd too, or the subdirectory
      // computation breaks under symlinked parents (macOS /var → /private/var).
      const realCwd = await realpath(cwd);
      const repoRoot = await findRepoRoot(run, realCwd);
      if (!repoRoot) throw new GitError(`不是 git 仓库：${cwd}`);
      const path = join(worktreeRoot, id);
      await mkdir(worktreeRoot, { recursive: true });
      const result = await run(['worktree', 'add', '--detach', path, 'HEAD'], repoRoot);
      if (result.code !== 0) {
        throw new GitError(`创建 worktree 失败：${result.stderr.trim() || 'unknown git error'}`);
      }
      const sub = relative(repoRoot, realCwd);
      return { cwd: sub ? join(path, sub) : path, repoRoot };
    },
  };
}
