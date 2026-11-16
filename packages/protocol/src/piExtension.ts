import { z } from 'zod';

/**
 * pi extensions are lines in settings JSON (`packages: [...]`), managed by
 * the pi CLI (D23, ADR 0020). v1 lists and edits the user scope only;
 * project-local `.pi/settings.json` lives in throwaway worktrees and stays
 * terminal-managed.
 */
export const piExtensionSchema = z.object({
  /** The source exactly as recorded: npm:pkg, git:url, https url or a path. */
  source: z.string(),
});
export type PiExtension = z.infer<typeof piExtensionSchema>;

/** A source the user typed; validated here so the CLI never gets garbage. */
export const piExtensionSourceSchema = z.string().trim().min(1).max(500);
