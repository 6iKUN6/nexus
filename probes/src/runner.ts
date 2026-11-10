import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessProbe, Scenario, ScenarioRecord, TurnRecord, TurnRequest } from './types.ts';

const GRACE_MS = 5_000;

export async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-probe-'));
  await writeFile(join(dir, 'hello.txt'), 'NEXUS-PROBE-LINE-1\nsecond line\n');
  await runQuiet('git', ['init', '-q'], dir);
  return dir;
}

function runQuiet(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      resolve(error ? `${stdout}${stderr}\n[error] ${error.message}` : `${stdout}${stderr}`);
    });
  });
}

/** Processes still alive in the given process group (the harness spawned them and did not reap them). */
async function listGroupMembers(pgid: number): Promise<string[]> {
  const output = await runQuiet('ps', ['-A', '-o', 'pid=,pgid=,command='], '/');
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const [, group] = line.split(/\s+/, 3);
      return Number(group) === pgid;
    });
}

function eventKey(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const top = obj.type ?? obj.method ?? obj.event;
  if (typeof top !== 'string') return null;
  for (const nested of ['event', 'item', 'msg', 'message', 'params']) {
    const inner = obj[nested];
    if (inner && typeof inner === 'object') {
      const sub = (inner as Record<string, unknown>).type;
      if (typeof sub === 'string') return `${top}/${sub}`;
    }
  }
  return top;
}

type TurnContext = {
  harness: HarnessProbe;
  scenario: Scenario;
  turn: TurnRequest;
  outDir: string;
};

export async function runTurn({
  harness,
  scenario,
  turn,
  outDir,
}: TurnContext): Promise<TurnRecord> {
  const args = harness.buildTurnArgs(turn);
  const base: TurnRecord = {
    argv: args ? [harness.binary, ...args] : [],
    exitCode: null,
    signal: null,
    durationMs: 0,
    firstStdoutMs: null,
    stdoutLines: 0,
    jsonLines: 0,
    nonJsonLines: 0,
    eventTypes: {},
    sessionId: null,
    cancel: null,
    orphans: [],
    timedOut: false,
    expectMatched: null,
    spawnError: null,
  };
  if (!args)
    return {
      ...base,
      spawnError: 'buildTurnArgs returned null (not defined for this harness yet)',
    };

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const started = performance.now();
  const record = { ...base };

  // detached => the child leads its own process group, so we can signal and inspect the whole tree.
  const child = spawn(harness.binary, args, {
    cwd: turn.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // group already gone
    }
  };

  let buffered = '';
  let cancelTimer: NodeJS.Timeout | null = null;
  const timers: NodeJS.Timeout[] = [];
  const escalate = (from: number) => {
    timers.push(
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        signalGroup('SIGTERM');
        if (record.cancel) record.cancel.escalatedTo = 'SIGTERM';
        timers.push(
          setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            signalGroup('SIGKILL');
            if (record.cancel) record.cancel.escalatedTo = 'SIGKILL';
          }, GRACE_MS),
        );
      }, from),
    );
  };

  const onLine = (line: string) => {
    if (!line.trim()) return;
    record.stdoutLines++;
    if (record.firstStdoutMs === null)
      record.firstStdoutMs = Math.round(performance.now() - started);
    try {
      const json: unknown = JSON.parse(line);
      record.jsonLines++;
      const key = eventKey(json);
      if (key) record.eventTypes[key] = (record.eventTypes[key] ?? 0) + 1;
      record.sessionId ??= harness.findSessionId(json, turn);
    } catch {
      record.nonJsonLines++;
    }
    const trigger = scenario.cancel;
    if (trigger && !cancelTimer && record.stdoutLines >= trigger.afterLines) {
      cancelTimer = setTimeout(() => {
        record.cancel = { sentAtMs: Math.round(performance.now() - started), escalatedTo: null };
        signalGroup('SIGINT');
        escalate(GRACE_MS);
      }, trigger.delayMs);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutChunks.push(chunk);
    buffered += chunk;
    let index = buffered.indexOf('\n');
    while (index !== -1) {
      onLine(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

  const timeout = setTimeout(() => {
    record.timedOut = true;
    signalGroup('SIGINT');
    escalate(GRACE_MS);
  }, scenario.timeoutMs);

  await new Promise<void>((resolve) => {
    child.on('error', (error) => {
      record.spawnError = error.message;
      resolve();
    });
    child.on('close', (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      resolve();
    });
  });
  if (buffered) onLine(buffered);
  clearTimeout(timeout);
  if (cancelTimer) clearTimeout(cancelTimer);
  for (const timer of timers) clearTimeout(timer);
  record.durationMs = Math.round(performance.now() - started);

  if (child.pid !== undefined) {
    await new Promise((r) => setTimeout(r, 1_000));
    record.orphans = await listGroupMembers(child.pid);
    if (record.orphans.length > 0) signalGroup('SIGKILL'); // clean up after recording
  }

  const stdout = stdoutChunks.join('');
  if (scenario.expect && turn.turnIndex === scenario.turns.length - 1) {
    record.expectMatched = stdout.includes(scenario.expect);
  }

  const prefix = join(outDir, `turn-${turn.turnIndex}`);
  await writeFile(`${prefix}.stdout.jsonl`, stdout);
  await writeFile(`${prefix}.stderr.log`, stderrChunks.join(''));
  return record;
}

export async function runHelp(harness: HarnessProbe, outDir: string): Promise<string | null> {
  let version: string | null = null;
  for (const args of harness.helpCommands) {
    const output = await runQuiet(harness.binary, args, tmpdir());
    const name = args.join('_').replace(/[^a-z0-9_-]/gi, '') || 'bare';
    await writeFile(join(outDir, `help.${name}.txt`), output);
    if (args.includes('--version')) version = /\d+\.\d+\.\d+\S*/.exec(output)?.[0] ?? null;
  }
  return version;
}

export async function runScenario(
  harness: HarnessProbe,
  scenario: Scenario,
  outRoot: string,
): Promise<ScenarioRecord> {
  const startedAt = new Date().toISOString();
  const outDir = join(outRoot, harness.id, scenario.id, startedAt.replace(/[:.]/g, '-'));
  await mkdir(outDir, { recursive: true });
  const workspace = await createWorkspace();
  const harnessVersion = await runHelp(harness, outDir);

  const record: ScenarioRecord = {
    harness: harness.id,
    harnessVersion,
    scenario: scenario.id,
    startedAt,
    workspace,
    turns: [],
  };

  const presetSessionId = randomUUID();
  let sessionId: string | null = null;
  for (const [turnIndex, turn] of scenario.turns.entries()) {
    const result = await runTurn({
      harness,
      scenario,
      outDir,
      turn: {
        prompt: turn.prompt,
        cwd: workspace,
        sessionId,
        presetSessionId,
        turnIndex,
        permissionMode: turn.permissionMode ?? 'default',
      },
    });
    record.turns.push(result);
    sessionId = result.sessionId;
    if (result.spawnError) break;
  }

  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
