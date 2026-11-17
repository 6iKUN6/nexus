/**
 * D23 probe (quota-free): does `codex app-server` accept per-thread MCP
 * servers via `thread/start.config.mcp_servers`? No turn is started — the
 * answer comes from `mcpServerStatus/list`, so this never calls the model.
 *
 *   pnpm tsx src/mcpInject.ts
 *
 * Records wire traffic to output/codex/mcp-inject/<timestamp>/wire.jsonl.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'output');
const dir = join(
  OUTPUT_ROOT,
  'codex',
  'mcp-inject',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(dir, { recursive: true });
const wire = createWriteStream(join(dir, 'wire.jsonl'));
const log = (dirn: 'in' | 'out', msg: unknown) =>
  wire.write(`${JSON.stringify({ dir: dirn, at: Date.now(), msg })}\n`);

// --- A minimal stdio MCP server: initialize + one echo tool ----------------
const fakeServerPath = join(dir, 'fake-mcp.mjs');
writeFileSync(
  fakeServerPath,
  `let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{
  buffer+=chunk;
  let nl=buffer.indexOf('\\n');
  while(nl>=0){
    const line=buffer.slice(0,nl).trim();buffer=buffer.slice(nl+1);nl=buffer.indexOf('\\n');
    if(!line)continue;
    const msg=JSON.parse(line);
    if(msg.id===undefined)continue;
    let result;
    if(msg.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'nexus-probe',version:'0.0.0'}};
    else if(msg.method==='ping')result={};
    else if(msg.method==='tools/list')result={tools:[{name:'probe_echo',description:'Echo back the text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
    else if(msg.method==='tools/call')result={content:[{type:'text',text:'echo:'+JSON.stringify(msg.params?.arguments??{})}],isError:false};
    else result={};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
  }
});
`,
);

let current: ReturnType<typeof spawn> | null = null;
const child = spawn('codex', ['app-server'], {
  cwd: tmpdir(),
  stdio: ['pipe', 'pipe', 'pipe'],
});
current = child;
child.stderr.on('data', (chunk: Buffer) => log('out', { stderr: String(chunk) }));

let buffer = '';
let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const notifications: unknown[] = [];
const serverRequests: unknown[] = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
    if (!line) continue;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    log('out', msg);
    if (typeof msg.id !== 'number') {
      if ((msg as { method?: string }).method) notifications.push(msg);
      continue;
    }
    // Server-initiated request (e.g. an approval): record it and approve so
    // the tool actually runs — this is what Nexus's permission UI would do.
    if ((msg as { method?: string }).method) {
      serverRequests.push(msg);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'approved' } })}\n`,
      );
      continue;
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error.message ?? 'rpc error')));
    else p.resolve(msg.result);
  }
});

function request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
  const id = ++nextId;
  log('in', { jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, timeoutMs);
  });
}

type Status = {
  data?: Array<{
    name: string;
    runtimeStatus: string | null;
    tools: Record<string, unknown>;
    toolsError: string | null;
  }>;
};

async function status(): Promise<NonNullable<Status['data']>> {
  const result = (await request('mcpServerStatus/list', {})) as Status;
  return result.data ?? [];
}

const report: Record<string, unknown> = {};
try {
  await request('initialize', {
    clientInfo: { name: 'nexus-probe', title: null, version: '0.0.0' },
    capabilities: null,
  });
  log('in', { jsonrpc: '2.0', method: 'initialized' });
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');

  // Thread A: inject the fake server through config.mcp_servers.
  const startedA = (await request('thread/start', {
    cwd: tmpdir(),
    approvalPolicy: process.env.NEXUS_PROBE_POLICY ?? 'never',
    sandbox: 'read-only',
    config: {
      mcp_servers: {
        nexusprobe: { command: process.execPath, args: [fakeServerPath] },
      },
    },
  })) as { thread?: { id?: string } };
  const threadA = startedA.thread?.id ?? null;
  report.threadA = threadA;

  // Thread B: no config — if the injection leaks app-wide, B sees it too.
  const startedB = (await request('thread/start', {
    cwd: tmpdir(),
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })) as { thread?: { id?: string } };
  report.threadB = startedB.thread?.id ?? null;

  // MCP servers spin up asynchronously; poll until connected or 15s.
  const deadline = Date.now() + 15000;
  let seen: NonNullable<Status['data']> = [];
  for (;;) {
    seen = await status();
    const probe = seen.find((s) => s.name === 'nexusprobe');
    if (probe?.runtimeStatus === 'connected' || probe?.runtimeStatus === 'failed') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  report.servers = seen.map((s) => ({
    name: s.name,
    runtimeStatus: s.runtimeStatus,
    tools: Object.keys(s.tools),
    toolsError: s.toolsError,
  }));
  // Per-thread detail: does the status differ by threadId?
  const byThread = (await request('mcpServerStatus/list', {
    threadId: threadA,
  })) as Status;
  report.serversForThreadA = (byThread.data ?? []).map((s) => ({
    name: s.name,
    runtimeStatus: s.runtimeStatus,
  }));

  // Direct client-initiated tool call (no model turn, quota-free): proves
  // the injected server is callable end to end.
  try {
    report.directToolCall = await request('mcpServer/tool/call', {
      threadId: threadA,
      server: 'nexusprobe',
      tool: 'probe_echo',
      arguments: { text: 'direct-call-ok' },
    });
  } catch (error) {
    report.directToolCall = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Quota step (one minimal turn): does the model actually call the injected
  // tool? Everything before this line was free. Already answered on
  // 2026-11-17 (model attempted probe_echo; blocked only by approval policy
  // 'never'), so re-runs can skip it to avoid spending quota again.
  if (!process.env.NEXUS_PROBE_SKIP_TURN) {
    const turn = (await request(
      'turn/start',
      {
        threadId: threadA,
        input: [
          {
            type: 'text',
            text: '调用 probe_echo 工具，text 传 "nexus-probe-ok"。不要做任何其他事，然后只回复工具的输出。',
            text_elements: [],
          },
        ],
      },
      120000,
    )) as { turn?: { status?: string; error?: { message?: string } | null } };
    // turn/start returns as soon as the turn is accepted; wait for the
    // turn/completed notification before collecting the tool calls.
    const turnDone = Date.now() + 120000;
    for (;;) {
      const done = notifications.some(
        (n) => (n as { method?: string }).method === 'turn/completed',
      );
      if (done) break;
      if (Date.now() > turnDone) {
        report.turnTimedOut = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const items = notifications
      .map(
        (n) =>
          n as {
            method?: string;
            params?: { item?: { type?: string; server?: string; tool?: string; result?: unknown } };
          },
      )
      .filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall')
      .map((n) => ({
        server: n.params?.item?.server,
        tool: n.params?.item?.tool,
        result: n.params?.item?.result,
      }));
    const agentText = notifications
      .filter((n) => (n as { method?: string }).method === 'item/agentMessage/delta')
      .map((n) => String((n as { params?: { delta?: string } }).params?.delta ?? ''))
      .join('');
    report.serverRequests = serverRequests.map((m) => {
      const r = m as { method?: string; params?: unknown };
      return { method: r.method, params: r.params };
    });
    report.turn = {
      status: turn.turn?.status,
      error: turn.turn?.error ?? null,
      mcpToolCalls: items,
      agentText,
    };
  } else {
    report.turn = { skipped: true };
  }

  // Resume path (Nexus restart recovery): the thread now has a rollout, so
  // resume accepts it — with a FRESH config override. If the override is
  // honoured, nexusprobe2 connects on the same thread.
  try {
    await request('thread/resume', {
      threadId: threadA,
      excludeTurns: true,
      config: {
        mcp_servers: { nexusprobe2: { command: process.execPath, args: [fakeServerPath] } },
      },
    });
    const deadline2 = Date.now() + 15000;
    let rows2: Array<{ name: string; runtimeStatus: string | null }> = [];
    for (;;) {
      const st = (await request('mcpServerStatus/list', { threadId: threadA })) as Status;
      rows2 = (st.data ?? []).map((x) => ({ name: x.name, runtimeStatus: x.runtimeStatus }));
      const probe = rows2.find((x) => x.name === 'nexusprobe2');
      if (probe?.runtimeStatus === 'connected' || probe?.runtimeStatus === 'failed') break;
      if (Date.now() > deadline2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    report.resume = { servers: rows2 };
  } catch (resumeError) {
    report.resume = {
      error: resumeError instanceof Error ? resumeError.message : String(resumeError),
    };
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  current?.kill('SIGINT');
  setTimeout(() => current?.kill('SIGKILL'), 2000);
}

/** Second app-server process: resume the thread with a fresh config override. */
async function resumeWithConfig(threadId: string, serverPath: string) {
  const proc = spawn('codex', ['app-server'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
  current = proc;
  proc.stderr.on('data', (chunk: Buffer) => log('out', { stderr: String(chunk) }));
  let buf = '';
  let id = 1000;
  const pend = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      log('out', msg);
      if (typeof msg.id !== 'number') continue;
      const p = pend.get(msg.id);
      if (!p) continue;
      pend.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'rpc error')));
      else p.resolve(msg.result);
    }
  });
  const req = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const rid = ++id;
      pend.set(rid, { resolve, reject });
      log('in', { jsonrpc: '2.0', id: rid, method, params });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
      setTimeout(() => {
        if (pend.delete(rid)) reject(new Error(`timeout: ${method}`));
      }, 15000);
    });
  await req('initialize', {
    clientInfo: { name: 'nexus-probe', title: null, version: '0.0.0' },
    capabilities: null,
  });
  proc.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
  const resumedThread = await req('thread/resume', {
    threadId,
    excludeTurns: true,
    config: { mcp_servers: { nexusprobe2: { command: process.execPath, args: [serverPath] } } },
  });
  const deadline = Date.now() + 15000;
  let rows: Array<{ name: string; runtimeStatus: string | null }> = [];
  for (;;) {
    const st = (await req('mcpServerStatus/list', { threadId })) as Status;
    rows = (st.data ?? []).map((x) => ({ name: x.name, runtimeStatus: x.runtimeStatus }));
    const probe = rows.find((x) => x.name === 'nexusprobe2');
    if (probe?.runtimeStatus === 'connected' || probe?.runtimeStatus === 'failed') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { resumedThread, servers: rows };
}

// Cross-process resume (the real Nexus restart case): a NEW app-server
// process resumes the thread with a FRESH config override. Quota-free.
// NEXUS_PROBE_RESUME_THREAD resumes an older thread that already has a
// rollout (e.g. from a previous quota run), so this step stays quota-free.
const resumeTarget = process.env.NEXUS_PROBE_RESUME_THREAD ?? report.threadA;
if (typeof resumeTarget === 'string') {
  try {
    report.crossProcessResume = await resumeWithConfig(resumeTarget, fakeServerPath);
  } catch (error) {
    report.crossProcessResume = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  current?.kill('SIGINT');
  setTimeout(() => current?.kill('SIGKILL'), 2000);
}

log('out', { probeMeta: report });
wire.end();
console.log(JSON.stringify(report, null, 2));
console.log(`wire: ${join(dir, 'wire.jsonl')}`);
process.exit(0);
