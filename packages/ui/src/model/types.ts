import type { HarnessId, PermissionOption } from '@nexus/protocol';

/**
 * View models: what the screen renders. Derived from core events by
 * `buildTimeline`; never persisted, never sent back to core.
 */

export type Persona = {
  name: string;
  monogram: string;
  /** Tailwind background class (token-based). */
  tone: string;
};

export const PERSONAS: Record<HarnessId, Persona> = {
  'claude-code': { name: 'Claude Code', monogram: 'C', tone: 'bg-sys-orange' },
  codex: { name: 'Codex', monogram: 'X', tone: 'bg-sys-indigo' },
  pi: { name: 'pi', monogram: 'π', tone: 'bg-sys-purple' },
  dsh: { name: 'DeepSeek Harness', monogram: 'D', tone: 'bg-sys-teal' },
  fake: { name: 'Fake', monogram: 'F', tone: 'bg-sys-gray' },
};

export type TimelineItem =
  | { kind: 'user'; id: string; at: number; text: string; queued: boolean }
  | { kind: 'agent'; id: string; at: number; runId: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      runId: string;
      name: string;
      detail: string;
      status: 'running' | 'ok' | 'error' | 'unknown';
      output: string | null;
    }
  | {
      kind: 'permission';
      id: string;
      runId: string;
      requestId: string;
      description: string;
      options: PermissionOption[];
      state: 'pending' | 'resolved' | 'expired';
      chosen: PermissionOption | null;
    }
  | { kind: 'failure'; id: string; runId: string; code: string; message: string }
  | { kind: 'system'; id: string; text: string };

export type RunSummary = {
  runId: string;
  startedAt: number | null;
  endedAt: number | null;
  outcome: 'running' | 'completed' | 'cancelled' | 'failed' | 'queued';
  inputTokens: number | null;
  outputTokens: number | null;
};
