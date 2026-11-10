import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Process-group helpers shared by adapters (ADR 0010).
 *
 * A harness is spawned as its own process group (`detached: true`) so cancelling
 * or disposing a session can reach tool subprocesses too. Sending a signal is
 * not the same as the process being gone: `terminateProcessGroup` keeps polling
 * the group and only reports `confirmed: true` after the kernel says it is
 * empty, because handoff (M4) must never start a second agent in a directory a
 * previous one may still be writing to.
 */

export type StopOutcome = {
  /** True only when the whole process group is gone (or was never alive). */
  confirmed: boolean;
  /** Why it could not be confirmed; shown verbatim. Null when confirmed. */
  problem: string | null;
};

export type TerminateOptions = {
  /** How long the group gets after SIGTERM before SIGKILL. Default 2000ms. */
  graceMs?: number;
  /** How long to keep polling after SIGKILL. Default 2000ms. */
  killWaitMs?: number;
  /** Poll interval. Default 50ms. */
  pollMs?: number;
};

/** True while the process group has at least one member. */
export function isGroupAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering anything.
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the group exists but is owned by someone else.
    return code === 'EPERM';
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves true when the group is gone within `timeoutMs`. */
export async function waitForGroupExit(
  pid: number,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isGroupAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(pollMs);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): 'sent' | 'gone' | 'failed' {
  try {
    process.kill(-pid, signal);
    return 'sent';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    return 'failed';
  }
}

/**
 * SIGTERM the group, then SIGKILL after the grace window, and verify it is
 * gone. An undefined pid (the spawn never produced one) is never "confirmed":
 * nothing is known to have stopped.
 */
export async function terminateProcessGroup(
  pid: number | undefined,
  options: TerminateOptions = {},
): Promise<StopOutcome> {
  const { graceMs = 2000, killWaitMs = 2000, pollMs = 50 } = options;
  if (pid === undefined) {
    return { confirmed: false, problem: '进程没有 pid，无法确认已停止。' };
  }
  const term = signalGroup(pid, 'SIGTERM');
  if (term === 'gone') return { confirmed: true, problem: null };
  if (term === 'failed') {
    return { confirmed: false, problem: '无法向进程组发送 SIGTERM，无法确认已停止。' };
  }
  if (await waitForGroupExit(pid, graceMs, pollMs)) return { confirmed: true, problem: null };

  const kill = signalGroup(pid, 'SIGKILL');
  if (kill === 'gone') return { confirmed: true, problem: null };
  if (kill === 'failed') {
    return { confirmed: false, problem: '无法向进程组发送 SIGKILL，无法确认已停止。' };
  }
  if (await waitForGroupExit(pid, killWaitMs, pollMs)) return { confirmed: true, problem: null };
  return {
    confirmed: false,
    problem: `进程组 ${pid} 在 SIGKILL 后仍未退出，无法确认已停止。`,
  };
}

export type GroupedProcess = {
  child: ChildProcess;
  /** The group id (same as the child pid); undefined when spawn failed. */
  pid: number | undefined;
};

/** Spawns a detached child that leads its own process group. */
export function spawnGrouped(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
): GroupedProcess {
  const child = spawn(command, [...args], { ...options, detached: true });
  return { child, pid: child.pid };
}
