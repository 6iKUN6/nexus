import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isGroupAlive, spawnGrouped, terminateProcessGroup, waitForGroupExit } from './index';

/**
 * These tests use real processes on purpose: the whole point is what the
 * kernel says about a process group, which no mock can reproduce.
 */
describe('process groups', () => {
  it('terminates the whole group, including a tool subprocess', async () => {
    // The leader spawns a grandchild that ignores SIGTERM, like a tool process
    // that outlives its parent (the M0 probe showed this pattern).
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      g.unref();
      console.log(g.pid);
      setInterval(() => {}, 1000);
    `;
    const { child, pid } = spawnGrouped(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!pid) throw new Error('spawn failed');
    const grandchild = await new Promise<number>((resolve, reject) => {
      child.stdout?.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim())));
      child.once('error', reject);
    });
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(isGroupAlive(pid)).toBe(true);
    expect(alive(grandchild)).toBe(true);

    const outcome = await terminateProcessGroup(pid, { graceMs: 300, killWaitMs: 2000 });
    expect(outcome).toEqual({ confirmed: true, problem: null });
    expect(isGroupAlive(pid)).toBe(false);
    // The grandchild ignored SIGTERM, so only the SIGKILL pass can have removed it.
    expect(alive(grandchild)).toBe(false);
  });

  it('confirms a group that already exited', async () => {
    const { child, pid } = spawnGrouped(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    if (!pid) throw new Error('spawn failed');
    await new Promise((resolve) => child.once('exit', resolve));
    // A reaped child's pgid no longer exists; even if the pid were reused this
    // call must not report a live group for our own spawn.
    expect(await terminateProcessGroup(pid, { graceMs: 100, killWaitMs: 100 })).toMatchObject({
      confirmed: true,
    });
    expect(await waitForGroupExit(pid, 100)).toBe(true);
  });

  it('is never confirmed when there is no pid', async () => {
    const outcome = await terminateProcessGroup(undefined);
    expect(outcome.confirmed).toBe(false);
    expect(outcome.problem).toContain('pid');
  });

  it('spawns into a new group, not the caller group', () => {
    const { child, pid } = spawnGrouped(process.execPath, ['-e', 'setTimeout(()=>{},3000)'], {
      stdio: 'ignore',
    });
    if (!pid) throw new Error('spawn failed');
    try {
      // pgid of the child equals its pid only when it leads a new group.
      const pgid = Number(
        execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
      );
      expect(pgid).toBe(pid);
    } finally {
      process.kill(-pid, 'SIGKILL');
      child.unref();
    }
  });
});
