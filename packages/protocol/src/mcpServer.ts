import { z } from 'zod';

/**
 * A user-managed MCP server (D23, ADR 0020). v1 is stdio only: a local
 * command plus argv and env. Env values may be `${VAR}` placeholders, which
 * core resolves from the user's login-shell environment at session creation —
 * secrets are never stored in the database.
 */
export const MCP_ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const envVars = z.record(z.string().trim().min(1).max(60), z.string().max(500));

export const mcpServerConfigSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(500)).max(50),
  env: envVars,
  /** Global on/off; conversations additionally opt in via enabledMcpIds. */
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/** List view: the config plus which placeholder names have no value. */
export const mcpServerViewSchema = mcpServerConfigSchema.extend({
  unresolvedEnv: z.array(z.string()),
});
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

/** Everything the user may set; id/timestamps belong to core. */
export const mcpServerInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: envVars.default({}),
  enabled: z.boolean().default(true),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

/**
 * Runtime form handed to adapters: `key` is a safe MCP server name derived
 * from the id (never the user's free-form name), env is already resolved.
 */
export const mcpServerRuntimeSchema = z.object({
  key: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});
export type McpServerRuntime = z.infer<typeof mcpServerRuntimeSchema>;
