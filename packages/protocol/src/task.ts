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
