import { z } from 'zod';
import { agentEventSchema } from './events';
import { harnessIdSchema } from './harness';
import { taskStatusSchema } from './task';

/**
 * Conversation domain (M1). A conversation is the persistent chat the user
 * sees; it is bound to one harness and one working directory. Its history is
 * an append-only list of events with a per-conversation monotonic `seq`;
 * the UI derives everything (timeline, status, unread) from that list.
 */

export const conversationStateSchema = z.enum([
  'idle',
  'running',
  'waiting_user',
  'completed',
  'failed',
]);
export type ConversationState = z.infer<typeof conversationStateSchema>;

/** How a conversation's working directory is isolated (ADR 0006). */
export const isolationSchema = z.enum(['direct', 'worktree']);
export type Isolation = z.infer<typeof isolationSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  harnessId: harnessIdSchema,
  /** Absolute working directory the harness runs in (the worktree, when isolated). */
  cwd: z.string(),
  isolation: isolationSchema,
  /** The directory the user originally picked; null for direct conversations. */
  baseCwd: z.string().nullable(),
  /** Session id inside the harness; set after the first run. */
  externalSessionId: z.string().nullable(),
  /**
   * Incremented whenever the owner (harness) changes, e.g. by a handoff.
   * Handoff commits compare-and-set against the value the user reviewed.
   */
  ownerVersion: z.number().int().positive(),
  state: conversationStateSchema,
  /** Seq of the newest event, 0 when empty. */
  lastSeq: z.number().int().nonnegative(),
  /** Short text for list rows. */
  preview: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** Events core records itself, next to the adapter's AgentEvents. */
export const coreEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user.message'), messageId: z.string(), text: z.string() }),
  /** A prompt waiting because the session is busy. */
  z.object({ type: z.literal('run.queued'), runId: z.string(), messageId: z.string() }),
  z.object({
    type: z.literal('permission.resolved'),
    runId: z.string(),
    requestId: z.string(),
    optionId: z.string(),
  }),
  /** A sub-task was delegated from this conversation; the card starts here. */
  z.object({
    type: z.literal('task.delegated'),
    taskId: z.string(),
    childConversationId: z.string(),
    goal: z.string(),
    acceptance: z.string().nullable(),
    harnessId: harnessIdSchema,
  }),
  /** A delegated task changed status (recorded on the parent's log). */
  z.object({
    type: z.literal('task.updated'),
    taskId: z.string(),
    status: taskStatusSchema,
    summary: z.string().nullable(),
  }),
  /**
   * A handoff reached a final state (M4). `stopping_source`/`prepared` are
   * transient and never persisted; a blocked handoff is recorded as `aborted`
   * so the timeline explains why the owner did not change.
   */
  z.object({
    type: z.literal('handoff'),
    handoffId: z.string(),
    fromHarnessId: harnessIdSchema,
    toHarnessId: harnessIdSchema,
    goal: z.string(),
    state: z.enum(['committed', 'aborted', 'needs_reconciliation']),
    problem: z.string().nullable(),
  }),
]);

export const conversationEventBodySchema = z.union([agentEventSchema, coreEventSchema]);
export type ConversationEventBody = z.infer<typeof conversationEventBodySchema>;

export const conversationEventSchema = z.object({
  conversationId: z.string(),
  seq: z.number().int().positive(),
  at: z.number().int(),
  body: conversationEventBodySchema,
});
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
