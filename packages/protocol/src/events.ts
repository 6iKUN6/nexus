import { z } from 'zod';

/**
 * Unified events emitted by adapters for a single Run.
 * Adapters do not assign sequence numbers or timestamps; core does that when
 * it persists the event, so ordering is decided in one place.
 */
const runRef = { runId: z.string().min(1) };

export const permissionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

export const stopReasonSchema = z.enum(['end_turn', 'cancelled', 'max_tokens', 'refused', 'other']);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), ...runRef }),
  z.object({ type: z.literal('text.delta'), ...runRef, text: z.string() }),
  z.object({
    type: z.literal('tool.started'),
    ...runRef,
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    ...runRef,
    toolCallId: z.string(),
    status: z.enum(['ok', 'error']),
    summary: z.string().nullable(),
  }),
  z.object({
    type: z.literal('permission.requested'),
    ...runRef,
    requestId: z.string(),
    toolCallId: z.string().nullable(),
    description: z.string(),
    options: z.array(permissionOptionSchema).min(1),
  }),
  z.object({
    type: z.literal('input.requested'),
    ...runRef,
    requestId: z.string(),
    prompt: z.string(),
  }),
  z.object({
    type: z.literal('usage.updated'),
    ...runRef,
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    /** True when the adapter has no exact tokenizer and the numbers are estimates. */
    estimated: z.boolean(),
  }),
  z.object({ type: z.literal('run.completed'), ...runRef, stopReason: stopReasonSchema }),
  z.object({
    type: z.literal('run.failed'),
    ...runRef,
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];
