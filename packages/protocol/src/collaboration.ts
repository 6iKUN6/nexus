import { z } from 'zod';
import { harnessIdSchema } from './harness';
import { messageStateSchema } from './message';

/**
 * The collaboration tools core offers to agent sessions (D14, ADR 0016).
 * One definition shared by three consumers: the core socket server, the
 * stdio MCP server inside `nexus-helper`, and the helper's one-shot CLI.
 *
 * Schemas stay terse: every tool definition is tokens in the model's context
 * the moment the harness loads the MCP server.
 */

export const collaborationTools = {
  send_message: {
    description: 'Send a message to the parent conversation of this subtask.',
    params: z.object({
      text: z.string().min(1).max(2000),
      to: z.literal('parent').default('parent'),
      /** Set when replying to a message; that message moves to `replied`. */
      reply_to: z.string().optional(),
    }),
    // D15: the state after the call — usually `delivered`, `failed` if the
    // recipient could not take it.
    result: z.object({ messageId: z.string(), state: messageStateSchema }),
  },
  delegate: {
    description: 'Delegate a subtask; it runs in its own isolated worktree.',
    params: z.object({
      goal: z.string().min(1).max(500),
      acceptance: z.string().max(1000).optional(),
      harness: harnessIdSchema.optional(),
    }),
    result: z.object({ taskId: z.string(), conversationId: z.string() }),
  },
  report_result: {
    description: 'Report this subtask result to the parent.',
    params: z.object({
      summary: z.string().min(1).max(2000),
      blocked: z.boolean().default(false),
    }),
    result: z.object({ taskId: z.string(), status: z.enum(['review', 'failed']) }),
  },
  request_handoff: {
    description: 'Ask the user to hand this task to another harness.',
    params: z.object({ toHarnessId: harnessIdSchema, reason: z.string().min(1).max(500) }),
    result: z.object({ recorded: z.literal(true) }),
  },
  open_preview: {
    description: 'Ask the user to open a localhost page in the preview pane.',
    params: z.object({ url: z.string().min(1).max(500) }),
    result: z.object({ recorded: z.literal(true) }),
  },
  read_task_context: {
    description: 'Read the task this conversation belongs to.',
    params: z.object({}),
    result: z.object({
      role: z.enum(['parent', 'child', 'standalone']),
      taskId: z.string().nullable(),
      goal: z.string().nullable(),
      acceptance: z.string().nullable(),
      status: z.string().nullable(),
      /** Sub-tasks this conversation delegated (D16); empty for child/standalone. */
      children: z
        .array(
          z.object({
            taskId: z.string(),
            goal: z.string(),
            status: z.string(),
            summary: z.string().nullable(),
          }),
        )
        .default([]),
    }),
  },
} satisfies Record<string, { description: string; params: z.ZodType; result: z.ZodType }>;

export type CollaborationTool = keyof typeof collaborationTools;

/** Wire method on the core socket for a tool. */
export function collaborationMethod(tool: CollaborationTool): string {
  return `collab.${tool}`;
}
/**
 * JSON Schema for an MCP `tools/list` entry. Derived from the zod definition so
 * the wire server, the helper and the docs cannot drift apart.
 */
export function collaborationToolSchema(tool: CollaborationTool): Record<string, unknown> {
  return z.toJSONSchema(collaborationTools[tool].params, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}
