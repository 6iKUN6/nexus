import { connect, type Socket } from 'node:net';
import {
  type CollaborationTool,
  collaborationMethod,
  collaborationToolSchema,
  collaborationTools,
} from '@nexus/protocol';

/**
 * `nexus-helper` (D14, ADR 0016). One implementation, two shapes:
 *
 *   nexus-helper mcp          stdio MCP server (Claude and other MCP harnesses)
 *   nexus-helper <tool> [json] one-shot command (pi, and humans debugging)
 *
 * It holds no state: every call opens the local socket, authenticates with the
 * per-session token from the environment and forwards one JSON-RPC request.
 * That keeps the token out of argv and out of anything the agent can list.
 */

const TOOL_NAMES = Object.keys(collaborationTools) as CollaborationTool[];

class HelperError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

class CoreConnection {
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error) => this.fail(new HelperError(-32000, error.message)));
    socket.on('close', () => this.fail(new HelperError(-32000, '协作通道连接已关闭')));
    socket.setTimeout(15_000, () => {
      this.fail(new HelperError(-32004, '协作通道响应超时'));
      socket.destroy();
    });
  }

  static open(): Promise<CoreConnection> {
    const socketPath = process.env.NEXUS_SOCKET;
    const token = process.env.NEXUS_TOKEN;
    if (!socketPath || !token) {
      return Promise.reject(
        new HelperError(-32000, '协作通道未配置（缺少 NEXUS_SOCKET / NEXUS_TOKEN）'),
      );
    }
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(new HelperError(-32000, `无法连接 Nexus：${error.message}`));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        const connection = new CoreConnection(socket);
        connection
          .request('auth', { token })
          .then(() => resolve(connection))
          .catch((error: unknown) => {
            connection.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new HelperError(-32000, '协作通道连接已关闭'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.fail(new HelperError(-32000, '协作通道连接已关闭'));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message !== 'object' || message === null) continue;
      const { id, result, error } = message as {
        id?: unknown;
        result?: unknown;
        error?: { code?: unknown; message?: unknown } | undefined;
      };
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (error) {
        const code = typeof error.code === 'number' ? error.code : -32000;
        pending.reject(new HelperError(code, String(error.message ?? '未知错误')));
      } else {
        pending.resolve(result);
      }
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function callTool(tool: CollaborationTool, params: unknown): Promise<unknown> {
  const connection = await CoreConnection.open();
  try {
    return await connection.request(collaborationMethod(tool), params);
  } finally {
    connection.close();
  }
}

// --- MCP stdio server -------------------------------------------------------

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolList() {
  return TOOL_NAMES.map((name) => ({
    name,
    description: collaborationTools[name].description,
    inputSchema: collaborationToolSchema(name),
  }));
}

async function mcpRequest(method: unknown, params: unknown): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested =
        typeof params === 'object' && params !== null && 'protocolVersion' in params
          ? (params as { protocolVersion: unknown }).protocolVersion
          : undefined;
      return {
        protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'nexus-collaboration', version: '0.1.0' },
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolList() };
    case 'tools/call': {
      const call =
        typeof params === 'object' && params !== null
          ? (params as { name?: unknown; arguments?: unknown })
          : {};
      const name = call.name;
      if (typeof name !== 'string' || !TOOL_NAMES.includes(name as CollaborationTool)) {
        throw new HelperError(-32602, `未知工具：${String(name)}`);
      }
      try {
        const result = await callTool(name as CollaborationTool, call.arguments ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        };
      } catch (error) {
        // Tool failures are results, not transport errors: the agent needs to
        // see the message and decide what to do next.
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    }
    default:
      throw new HelperError(-32601, `未知方法：${String(method)}`);
  }
}

function startMcp(): void {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      void handleMcpLine(line);
    }
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
}

async function handleMcpLine(line: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无法解析 JSON' } });
    return;
  }
  if (typeof message !== 'object' || message === null) return;
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (id === undefined) return; // notification, nothing to answer
  try {
    const result = await mcpRequest(method, params);
    writeMessage({ jsonrpc: '2.0', id, result });
  } catch (error) {
    const code = error instanceof HelperError ? error.code : -32603;
    const text = error instanceof Error ? error.message : String(error);
    writeMessage({ jsonrpc: '2.0', id, error: { code, message: text } });
  }
}

// --- one-shot CLI -----------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

async function runOneShot(args: string[]): Promise<number> {
  const name = args[0];
  if (!name || name === '--help' || name === 'help') {
    process.stdout.write(
      `${JSON.stringify({
        usage: 'nexus-helper <tool> [json-args]  |  nexus-helper mcp',
        tools: TOOL_NAMES,
      })}\n`,
    );
    return 0;
  }
  if (!TOOL_NAMES.includes(name as CollaborationTool)) {
    process.stdout.write(
      `${JSON.stringify({ error: { message: `未知工具：${name}`, tools: TOOL_NAMES } })}\n`,
    );
    return 1;
  }
  const raw = args[1] ?? (process.stdin.isTTY ? '{}' : await readStdin());
  let params: unknown = {};
  try {
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(`${JSON.stringify({ error: { message: '参数不是合法的 JSON' } })}\n`);
    return 1;
  }
  try {
    const result = await callTool(name as CollaborationTool, params);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
    return 1;
  }
}

// --- entry ------------------------------------------------------------------

const mode = process.argv[2];
if (mode === 'mcp') {
  startMcp();
} else {
  void runOneShot(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
