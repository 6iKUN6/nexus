import { z } from 'zod';

/** Harnesses Nexus knows how to detect. Adapters may exist for a subset. */
// 'fake' is the scripted development harness; core only lists it when NEXUS_FAKE_HARNESS=1.
export const harnessIdSchema = z.enum(['claude-code', 'codex', 'pi', 'dsh', 'fake']);
export type HarnessId = z.infer<typeof harnessIdSchema>;

/**
 * Authentication is reported separately from installation on purpose:
 * "installed", "authenticated", "process running" and "answering" are
 * different states and the UI must never merge them into one dot.
 */
export const authStatusSchema = z.enum(['unknown', 'authenticated', 'unauthenticated']);
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const harnessInfoSchema = z.object({
  id: harnessIdSchema,
  displayName: z.string(),
  binaryName: z.string(),
  installed: z.boolean(),
  executablePath: z.string().nullable(),
  version: z.string().nullable(),
  auth: authStatusSchema,
  /** Human-readable reason when detection partially failed (e.g. version command timed out). */
  problem: z.string().nullable(),
  /** Nexus has an adapter for it, so conversations can be created. */
  chatSupported: z.boolean(),
});
export type HarnessInfo = z.infer<typeof harnessInfoSchema>;

export const harnessCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  permissions: z.boolean(),
  cancel: z.boolean(),
  interrupt: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  mcp: z.boolean(),
  usage: z.boolean(),
});
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;
