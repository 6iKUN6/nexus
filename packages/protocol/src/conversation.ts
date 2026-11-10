import { z } from 'zod';
import { agentEventSchema } from './events';
import { harnessIdSchema } from './harness';

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

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  harnessId: harnessIdSchema,
  /** Absolute working directory the harness runs in. */
  cwd: z.string(),
  /** Session id inside the harness; set after the first run. */
  externalSessionId: z.string().nullable(),
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
