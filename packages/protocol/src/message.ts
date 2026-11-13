import { z } from 'zod';

/**
 * Durable agent-to-agent messages (D15, ADR 0017). One row per message, used
 * as both the sender's outbox and the recipient's inbox; `id` is the dedupe
 * key. States are the delivery layer's business and never enter the event
 * log — the log records that a message exists, this table records how far it
 * got.
 */
export const messageStateSchema = z.enum([
  'queued', // written, not yet handed to the recipient conversation
  'delivered', // queued as a prompt in the recipient's serial queue
  'consumed', // the run carrying it actually started
  'replied', // a reply referencing this message was recorded
  'failed', // delivery failed outright (e.g. recipient gone)
  'needs_check', // restart or run failure left the outcome uncertain
]);
export type MessageState = z.infer<typeof messageStateSchema>;

export const messageRecordSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  recipientId: z.string(),
  taskId: z.string().nullable(),
  kind: z.literal('message'),
  text: z.string(),
  replyTo: z.string().nullable(),
  state: messageStateSchema,
  /** Run that carries the prompt, for delivered→consumed tracking. */
  runId: z.string().nullable(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
  consumedAt: z.number().nullable(),
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;
