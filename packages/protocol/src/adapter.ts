import type { AgentEvent } from './events';
import type { AuthStatus, HarnessCapabilities } from './harness';

/**
 * Contract every harness adapter implements (see 开发落地计划.md §9.2).
 * Optional members are capabilities; callers must check `probe()` results
 * before relying on them and degrade the UI when they are missing.
 */

export type ProbeResult = {
  harnessId: string;
  version: string | null;
  auth: AuthStatus;
  capabilities: HarnessCapabilities;
  /** Known gaps, shown to the user verbatim. */
  limitations: string[];
};

export type CreateSessionOptions = {
  /** Absolute working directory. The adapter must not write outside of it. */
  cwd: string;
  /**
   * Resolved harness executable, from core's detection. Adapters never search
   * PATH themselves, so what runs is exactly what the UI shows.
   */
  executablePath: string | null;
  /** Environment for the harness process (includes the login-shell PATH). */
  env: Record<string, string>;
};

/** Result of stopping a session: what the caller may safely claim afterwards. */
export type StopResult = {
  /** True only when the harness process tree is verified gone. */
  confirmed: boolean;
  /** Why it could not be confirmed; shown verbatim. Null when confirmed. */
  problem: string | null;
};

export type SendPromptInput = {
  /** Assigned by core; every event of this run carries it. */
  runId: string;
  text: string;
};

export type AdapterSession = {
  /**
   * Session id inside the harness. Only meaningful to the adapter that created
   * it. Core persists it and passes it to `resumeSession` after a restart.
   */
  readonly externalId: string;
  /**
   * Starts a run and streams its events. The iterable ends after exactly one
   * terminal event (`run.completed` or `run.failed`). A session runs one
   * prompt at a time; core serialises prompts per session.
   */
  sendPrompt(input: SendPromptInput): AsyncIterable<AgentEvent>;
  /** Requests cancellation; the stream still ends with a terminal event. */
  cancel(runId: string): Promise<void>;
  /** Rejects if the request is unknown, already answered or expired. */
  respondToPermission?(requestId: string, optionId: string): Promise<void>;
  /**
   * Stops the harness process tree and releases resources. Idempotent.
   * `confirmed` is true only when the adapter verified that no process of the
   * session is left (handoff depends on this; see ADR 0010).
   */
  dispose(): Promise<StopResult>;
};

export type AgentAdapter = {
  readonly harnessId: string;
  probe(): Promise<ProbeResult>;
  createSession(options: CreateSessionOptions): Promise<AdapterSession>;
  resumeSession?(externalId: string, options: CreateSessionOptions): Promise<AdapterSession>;
};
