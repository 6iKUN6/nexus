import { z } from 'zod';
import { harnessIdSchema } from './harness';

/**
 * Delegation domain (M3, ADR 0008). A task links a parent conversation to a
 * child conversation created for a delegated sub-goal. The task row is the
 * source of truth for status; the parent's event log mirrors every
 * transition (`task.delegated` / `task.updated`) so the timeline can render
 * live progress cards.
 *
 * Status machine: running → review (child finished) | failed (child run
 * failed); review/failed → running (user requests changes); review →
 * accepted (terminal).
 */
export const taskStatusSchema = z.enum(['running', 'review', 'accepted', 'failed']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  parentConversationId: z.string(),
  childConversationId: z.string(),
  /** The delegated sub-goal, verbatim from the user. */
  goal: z.string(),
  /** Acceptance criteria, one per line; null when not given. */
  acceptance: z.string().nullable(),
  harnessId: harnessIdSchema,
  status: taskStatusSchema,
  /** The child's latest result text, captured when it finished. */
  resultSummary: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Task = z.infer<typeof taskSchema>;

/**
 * What a delegated task actually changed (D16, ADR 0018). Computed on demand
 * from the child's worktree, never persisted: stored evidence would go stale.
 * Secret-looking files are only counted, never named or included in the diff.
 */
export const taskEvidenceSchema = z.object({
  available: z.boolean(),
  /** Why evidence is unavailable (worktree gone, not a repo, …). */
  problem: z.string().nullable(),
  baseCommit: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['added', 'modified', 'deleted']),
      added: z.number().nullable(),
      deleted: z.number().nullable(),
    }),
  ),
  untracked: z.array(z.string()),
  /** Number of untracked files that look like secrets and were omitted. */
  secretFilesOmitted: z.number(),
  diff: z.string().nullable(),
  diffTruncated: z.boolean(),
});
export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;
