import { stat } from 'node:fs/promises';
import type { TaskEvidence } from '@nexus/protocol';
import { type GitRun, SECRET_FILE } from '../worktree/gitWorktree';

/**
 * Computes what a delegated task actually changed in its worktree (D16,
 * ADR 0018). Always live: persisted evidence would just go stale. Files that
 * look like secrets are counted, never named and never diffed.
 */

const MAX_DIFF_CHARS = 12_000;

const unavailable = (problem: string): TaskEvidence => ({
  available: false,
  problem,
  baseCommit: null,
  files: [],
  untracked: [],
  secretFilesOmitted: 0,
  diff: null,
  diffTruncated: false,
});

export async function collectTaskEvidence(run: GitRun, cwd: string): Promise<TaskEvidence> {
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) {
    return unavailable('子任务的工作目录已经不存在');
  }
  const head = await run(['rev-parse', 'HEAD'], cwd);
  if (head.code !== 0) {
    return unavailable('子任务目录不是 git 仓库，无法计算改动');
  }

  const status = await run(['status', '--porcelain', '-z'], cwd);
  const untrackedAll: string[] = [];
  // Paths with staged/deleted-only changes that numstat alone would miss.
  const statusByPath = new Map<string, 'added' | 'modified' | 'deleted'>();
  if (status.code === 0) {
    const entries = status.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] ?? '';
      if (entry.length < 4) continue;
      const x = entry[0] ?? ' ';
      const y = entry[1] ?? ' ';
      const path = entry.slice(3);
      if (x === '?' && y === '?') {
        untrackedAll.push(path);
        continue;
      }
      // Renames/copies carry a second NUL-separated path; skip the source.
      if (x === 'R' || x === 'C') i += 1;
      statusByPath.set(path, y === 'D' || x === 'D' ? 'deleted' : x === 'A' ? 'added' : 'modified');
    }
  }

  const files: TaskEvidence['files'] = [];
  const numstat = await run(['diff', 'HEAD', '--numstat', '-z'], cwd);
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split('\0')) {
      if (!line.trim()) continue;
      const [added, deleted, path] = line.split('\t');
      if (!path) continue;
      files.push({
        path,
        status: statusByPath.get(path) ?? 'modified',
        added: added === '-' ? null : Number(added ?? 0),
        deleted: deleted === '-' ? null : Number(deleted ?? 0),
      });
      statusByPath.delete(path);
    }
  }
  // Staged-but-uncommitted additions and deletions numstat missed.
  for (const [path, fileStatus] of statusByPath) {
    files.push({ path, status: fileStatus, added: null, deleted: null });
  }

  const secrets = untrackedAll.filter((file) => SECRET_FILE.test(file));
  const diffResult = await run(['diff', 'HEAD'], cwd);
  const diff = diffResult.code === 0 ? diffResult.stdout : '';
  return {
    available: true,
    problem: null,
    baseCommit: head.stdout.trim() || null,
    files,
    untracked: untrackedAll.filter((file) => !SECRET_FILE.test(file)),
    secretFilesOmitted: secrets.length,
    diff: diff.trim() ? diff.slice(0, MAX_DIFF_CHARS) : null,
    diffTruncated: diff.length > MAX_DIFF_CHARS,
  };
}
