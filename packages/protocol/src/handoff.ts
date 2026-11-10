import { z } from 'zod';
import { harnessIdSchema } from './harness';

/**
 * Handoff domain (M4, ADR 0011). A handoff moves an in-progress conversation
 * to another harness *in the same worktree*: the source is stopped and
 * verified gone, a frozen context package is recorded, then ownership changes.
 *
 * State machine (plan §7, simplified version):
 *   stopping_source → prepared → committed → running
 *   any pre-commit step may end in `aborted` (owner unchanged)
 *   a commit whose receiver did not start ends in `needs_reconciliation`
 */

export const handoffStateSchema = z.enum([
  'stopping_source',
  'prepared',
  'committed',
  'running',
  'aborted',
  'needs_reconciliation',
]);
export type HandoffState = z.infer<typeof handoffStateSchema>;

/** A user requirement, verbatim, traceable to the message it came from. */
export const handoffRequirementSchema = z.object({
  text: z.string(),
  sourceMessageId: z.string(),
});
export type HandoffRequirement = z.infer<typeof handoffRequirementSchema>;

export const handoffOmittedSchema = z.object({
  item: z.string(),
  reason: z.string(),
});

/**
 * Working state frozen at `prepared`. The receiver works in the same
 * directory, so the diff and untracked list are a record of what it inherits,
 * not something to re-apply.
 */
export const handoffWorkspaceSchema = z.object({
  root: z.string(),
  baseCommit: z.string().nullable(),
  /** `git diff HEAD`, truncated when huge; null when clean or not a repo. */
  dirtyDiff: z.string().nullable(),
  untrackedFiles: z.array(z.string()),
});
export type HandoffWorkspace = z.infer<typeof handoffWorkspaceSchema>;

export const handoffPackageSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: z.string(),
  fromHarnessId: harnessIdSchema,
  toHarnessId: harnessIdSchema,
  /** The conversation owner version the package was frozen against. */
  ownerVersion: z.number().int().positive(),
  goal: z.string(),
  /** What the receiver should do first. */
  nextAction: z.string(),
  userRequirements: z.array(handoffRequirementSchema),
  confirmedFacts: z.array(z.string()),
  assumptions: z.array(z.string()),
  workspace: handoffWorkspaceSchema,
  /** Content left out of the brief, with the reason; never silent. */
  omitted: z.array(handoffOmittedSchema),
  /** Rough size of the assembled brief. There is no exact tokenizer here. */
  estimatedTokens: z.number().int().nonnegative(),
});
export type HandoffPackage = z.infer<typeof handoffPackageSchema>;

export const handoffSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  state: handoffStateSchema,
  fromHarnessId: harnessIdSchema,
  toHarnessId: harnessIdSchema,
  /** Set from `prepared` onwards. */
  package: handoffPackageSchema.nullable(),
  /** Why the handoff stopped; shown verbatim. Null unless failed. */
  problem: z.string().nullable(),
  /** Incremented on every transition; used for compare-and-set. */
  version: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Handoff = z.infer<typeof handoffSchema>;
