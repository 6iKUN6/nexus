/**
 * Probe model. A harness knows how to turn a turn request into argv and how
 * to find its session id in output; a scenario is a list of turns plus an
 * optional cancel trigger. Everything else (recording, timing, orphan
 * detection) is generic and lives in runner.ts.
 */

export type TurnRequest = {
  prompt: string;
  cwd: string;
  /** Session to continue; null for the first turn. */
  sessionId: string | null;
  /** Some harnesses (pi) let the caller choose the session id up front. */
  presetSessionId: string;
  turnIndex: number;
  /** Scenario wants the harness to ask before writing (no auto-approve flags). */
  permissionMode: 'default' | 'none';
};

export type HarnessProbe = {
  id: string;
  binary: string;
  /** argv for a headless, structured-output turn. Return null if unsupported. */
  buildTurnArgs(turn: TurnRequest): string[] | null;
  /** Extracts the harness session id from one parsed JSON output line. */
  findSessionId(json: unknown, turn: TurnRequest): string | null;
  /** Free commands (no model call) whose output documents the CLI surface. */
  helpCommands: string[][];
  notes?: string;
  /** Excluded from `all` (e.g. the runner self-test). */
  hidden?: boolean;
};

export type CancelTrigger = {
  /** Fire after this many stdout lines have been seen … */
  afterLines: number;
  /** … plus this delay. */
  delayMs: number;
};

export type Scenario = {
  id: string;
  title: string;
  /** Calls the model and spends quota. `help` is the only free scenario. */
  costsQuota: boolean;
  turns: Array<{ prompt: string; permissionMode?: 'default' | 'none' }>;
  cancel?: CancelTrigger;
  /** Expected substring in the final turn's stdout, used as a weak pass signal. */
  expect?: string;
  timeoutMs: number;
};

export type TurnRecord = {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  firstStdoutMs: number | null;
  stdoutLines: number;
  jsonLines: number;
  nonJsonLines: number;
  eventTypes: Record<string, number>;
  sessionId: string | null;
  cancel: { sentAtMs: number; escalatedTo: string | null } | null;
  orphans: string[];
  timedOut: boolean;
  expectMatched: boolean | null;
  spawnError: string | null;
};

export type ScenarioRecord = {
  harness: string;
  harnessVersion: string | null;
  scenario: string;
  startedAt: string;
  workspace: string;
  turns: TurnRecord[];
};
