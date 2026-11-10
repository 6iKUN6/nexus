/**
 * M2 adapter recon: drives `codex app-server` (stdio JSON-RPC) and
 * `pi --mode rpc` (JSONL stdio) through minimal scenarios and records the
 * raw bidirectional wire traffic. The recordings become adapter fixtures.
 *
 * Unlike the M0 one-shot probes these are long-lived sessions, so this is a
 * standalone runner: `pnpm probe:m2 codex|pi --yes`. It calls the model and
 * costs quota, hence --yes.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const OUTPUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'output');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { yes: { type: 'boolean', default: false } },
});
const harness = positionals[0];
const only = positionals[1] ?? null;
if ((harness !== 'codex' && harness !== 'pi') || !values.yes) {
  console.error('用法: pnpm probe:m2 <codex|pi> [场景] --yes   （会调用模型并消耗少量额度）');
  process.exit(2);
}

/** A recorded line: direction-tagged, timestamped, raw JSON preserved. */
type Rec = { dir: 'in' | 'out'; at: number; msg: unknown };

class Recorder {
  private stream: WriteStream;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.stream = createWriteStream(join(dir, 'wire.jsonl'));
  }
  log(dir: 'in' | 'out', msg: unknown) {
    this.stream.write(`${JSON.stringify({ dir, at: Date.now(), msg } satisfies Rec)}\n`);
  }
  meta(extra: Record<string, unknown>) {
    this.stream.write(
      `${JSON.stringify({ dir: 'out', at: Date.now(), msg: { probeMeta: extra } })}\n`,
    );
  }
  close() {
    this.stream.end();
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`超时: ${what}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Line-delimited JSON over a child process's stdio. Records every line both
 * ways. Handles JSON-RPC style id responses and server-initiated requests.
 */
class JsonlLink {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners: Array<(msg: Record<string, unknown>) => void> = [];
  /** Server→client requests we choose to answer (codex approvals). */
  onServerRequest: ((msg: Record<string, unknown>) => unknown) | null = null;

  private child: ReturnType<typeof spawn>;
  private rec: Recorder;

  constructor(child: ReturnType<typeof spawn>, rec: Recorder) {
    this.child = child;
    this.rec = rec;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = { unparseable: line };
        }
        rec.log('out', msg);
        this.dispatch(msg as Record<string, unknown>);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) rec.log('out', { stderr: line });
      }
    });
  }

  private dispatch(msg: Record<string, unknown>) {
    // A response: has id and result/error, no method.
    if (msg.method === undefined && msg.id !== undefined && typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error !== undefined) {
          entry.reject(new Error(JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
        return;
      }
    }
    // A server-initiated request we must answer.
    if (typeof msg.method === 'string' && msg.id !== undefined && this.onServerRequest) {
      const result = this.onServerRequest(msg);
      if (result !== undefined) this.respond(msg.id, result);
      return;
    }
    for (const l of this.listeners) l(msg);
  }

  /** Respond to a server-initiated request, preserving its id. */
  respond(id: unknown, result: unknown) {
    const line = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.rec.log('in', { jsonrpc: '2.0', id, result });
    this.child.stdin?.write(`${line}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.rec.log('in', { jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin?.write(`${line}\n`);
    });
  }

  notify(method: string) {
    const line = JSON.stringify({ jsonrpc: '2.0', method });
    this.rec.log('in', { jsonrpc: '2.0', method });
    this.child.stdin?.write(`${line}\n`);
  }

  /** pi-style command: id is a string, response arrives as {type:'response',id}. */
  sendCommand(cmd: Record<string, unknown>) {
    this.rec.log('in', cmd);
    this.child.stdin?.write(`${JSON.stringify(cmd)}\n`);
  }

  /** Wait for a notification matching pred. */
  waitFor(pred: (msg: Record<string, unknown>) => boolean, ms: number, what: string) {
    return withTimeout(
      new Promise<Record<string, unknown>>((resolve) => {
        this.listeners.push((msg) => {
          if (pred(msg)) resolve(msg);
        });
      }),
      ms,
      what,
    );
  }

  kill() {
    this.child.kill('SIGTERM');
    setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
  }
}

function scenarioDir(h: string, scenario: string) {
  return join(OUTPUT_ROOT, h, scenario, new Date().toISOString().replace(/[:.]/g, '-'));
}

// ---------------------------------------------------------------- codex ---

async function probeCodex() {
  const exe = process.env.NEXUS_PROBE_CODEX ?? 'codex';
  const started = new Date().toISOString();
  let basicThreadId: string | null = null;

  const run = async (
    scenario: string,
    body: (link: JsonlLink, rec: Recorder, cwd: string) => Promise<void>,
  ) => {
    if (only && scenario !== only) return;
    const rec = new Recorder(scenarioDir('codex', scenario));
    const cwd = await mkdtemp(join(tmpdir(), `nexus-probe-codex-${scenario}-`));
    rec.meta({ scenario, harness: 'codex', version: '0.154.0', cwd, started });
    const child = spawn(exe, ['app-server'], { cwd, env: process.env });
    const link = new JsonlLink(child, rec);
    try {
      await link.request('initialize', {
        clientInfo: { name: 'nexus-probe', title: null, version: '0.0.0' },
        capabilities: null,
      });
      link.notify('initialized');
      await body(link, rec, cwd);
      rec.meta({ outcome: 'ok' });
      console.log(`✔ codex/${scenario}`);
    } catch (error) {
      rec.meta({ outcome: 'failed', error: String(error) });
      console.error(`✘ codex/${scenario}: ${error}`);
    } finally {
      link.kill();
      rec.close();
      await sleep(300);
    }
  };

  // 1. basic: one short Q&A turn, default policies.
  await run('appserver-basic', async (link, _rec, cwd) => {
    const startedRes = (await link.request('thread/start', { cwd })) as {
      thread: { id: string };
    };
    basicThreadId = startedRes.thread.id;
    const done = link.waitFor(
      (m) => m.method === 'turn/completed',
      120_000,
      'turn/completed (basic)',
    );
    await link.request('turn/start', {
      threadId: basicThreadId,
      input: [{ type: 'text', text: '只回复 OK 两个字母，不要输出其他内容。', text_elements: [] }],
    });
    await done;
  });

  // 2. approval: untrusted policy + read-only sandbox forces an approval for a
  // file write. Accept whatever request arrives and record the exchange.
  await run('appserver-approval', async (link, _rec, cwd) => {
    const { thread } = (await link.request('thread/start', {
      cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    })) as { thread: { id: string } };
    let answered = 0;
    link.onServerRequest = (msg) => {
      answered++;
      if (msg.method === 'item/commandExecution/requestApproval') return { decision: 'accept' };
      if (msg.method === 'item/fileChange/requestApproval') return { decision: 'accept' };
      if (msg.method === 'item/permissions/requestApproval') return { decision: 'accept' };
      // Unknown server request: refuse so the turn cannot hang on us.
      return { decision: 'decline' };
    };
    const done = link.waitFor(
      (m) => m.method === 'turn/completed',
      180_000,
      'turn/completed (approval)',
    );
    await link.request('turn/start', {
      threadId: thread.id,
      input: [
        {
          type: 'text',
          text: '在当前目录创建文件 note.txt，内容为 hello-from-codex。创建后回复 DONE。',
          text_elements: [],
        },
      ],
    });
    await done;
    link.onServerRequest = null;
    if (answered === 0) console.warn('  ! 没有触发权限请求（策略可能自动放行）');
  });

  // 3. interrupt: long output, interrupt mid-stream.
  await run('appserver-interrupt', async (link, _rec, cwd) => {
    const { thread } = (await link.request('thread/start', { cwd })) as {
      thread: { id: string };
    };
    const turnDone = link.waitFor(
      (m) => m.method === 'turn/completed',
      120_000,
      'turn/completed (interrupt)',
    );
    const turn = (await link.request('turn/start', {
      threadId: thread.id,
      input: [
        {
          type: 'text',
          text: '请从 1 数到 300，每个数字单独一行，行末附一个不同的中文名词。不要省略。',
          text_elements: [],
        },
      ],
    })) as { turn: { id: string } };
    await link.waitFor(
      (m) => m.method === 'item/agentMessage/delta',
      60_000,
      'first delta (interrupt)',
    );
    await sleep(600);
    await link.request('turn/interrupt', { threadId: thread.id, turnId: turn.turn.id });
    await turnDone;
  });

  // 4. resume: re-attach to the basic thread and ask about the first prompt.
  if (basicThreadId) {
    await run('appserver-resume', async (link, _rec, cwd) => {
      await link.request('thread/resume', { threadId: basicThreadId });
      const done = link.waitFor(
        (m) => m.method === 'turn/completed',
        120_000,
        'turn/completed (resume)',
      );
      await link.request('turn/start', {
        threadId: basicThreadId,
        input: [
          {
            type: 'text',
            text: '这个对话里我第一条消息让你回复哪两个字母？只回答那两个字母。',
            text_elements: [],
          },
        ],
        cwd,
      });
      await done;
    });
  }
}

// ------------------------------------------------------------------- pi ---

async function probePi() {
  const exe = process.env.NEXUS_PROBE_PI ?? 'pi';
  const started = new Date().toISOString();

  const run = async (
    scenario: string,
    body: (link: JsonlLink, rec: Recorder, cwd: string) => Promise<void>,
  ) => {
    const rec = new Recorder(scenarioDir('pi', scenario));
    const cwd = await mkdtemp(join(tmpdir(), `nexus-probe-pi-${scenario}-`));
    rec.meta({ scenario, harness: 'pi', cwd, started });
    const child = spawn(exe, ['--mode', 'rpc'], { cwd, env: process.env });
    const link = new JsonlLink(child, rec);
    try {
      // Wait until the process is alive: ask for state.
      await sleep(500);
      link.sendCommand({ id: 'state-0', type: 'get_state' });
      await link.waitFor(
        (m) => m.type === 'response' && m.id === 'state-0',
        30_000,
        'get_state response',
      );
      await body(link, rec, cwd);
      rec.meta({ outcome: 'ok' });
      console.log(`✔ pi/${scenario}`);
    } catch (error) {
      rec.meta({ outcome: 'failed', error: String(error) });
      console.error(`✘ pi/${scenario}: ${error}`);
    } finally {
      link.kill();
      rec.close();
      await sleep(300);
    }
  };

  const promptAndWait = async (link: JsonlLink, id: string, message: string, ms: number) => {
    const end = link.waitFor(
      (m) => m.type === 'agent_end' || m.type === 'agent_settled',
      ms,
      `agent_end (${id})`,
    );
    link.sendCommand({ id, type: 'prompt', message });
    await end;
  };

  // 1. basic Q&A.
  await run('rpc-basic', async (link) => {
    await promptAndWait(link, 'p1', '只回复 OK 两个字母，不要输出其他内容。', 120_000);
  });

  // 2. write a file: pi has no permission gating; verify the file appears.
  await run('rpc-write', async (link, rec, cwd) => {
    await promptAndWait(link, 'p1', '创建文件 hello.txt，内容为 hi。完成后只回复 DONE。', 180_000);
    rec.meta({ fileCreated: existsSync(join(cwd, 'hello.txt')) });
  });

  // 3. abort mid-stream.
  await run('rpc-abort', async (link) => {
    const end = link.waitFor(
      (m) => m.type === 'agent_end' || m.type === 'agent_settled',
      120_000,
      'agent_end (abort)',
    );
    link.sendCommand({
      id: 'p1',
      type: 'prompt',
      message: '请从 1 数到 300，每个数字单独一行，行末附一个不同的中文名词。不要省略。',
    });
    await link.waitFor(
      (m) =>
        m.type === 'message_update' &&
        (m.assistantMessageEvent as { type?: string } | undefined)?.type === 'text_delta',
      60_000,
      'first text_delta (abort)',
    );
    await sleep(400);
    link.sendCommand({ id: 'a1', type: 'abort' });
    await end;
  });
}

if (harness === 'codex') await probeCodex();
else await probePi();
process.exit(0);
