import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collaborationTools } from '@nexus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { writePiBridge } from './piBridge';

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-bridge-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

describe('writePiBridge', () => {
  it('renders every collaboration tool from the protocol schemas', () => {
    const path = writePiBridge(tempDir());
    const source = readFileSync(path, 'utf8');
    for (const name of Object.keys(collaborationTools)) {
      expect(source).toContain(`"name": "${name}"`);
      expect(source).toContain(
        collaborationTools[name as keyof typeof collaborationTools].description,
      );
    }
    // The socket protocol mirrors the helper: auth first, one call per connection.
    expect(source).toContain("method: 'auth'");
    expect(source).toContain('process.env.NEXUS_SOCKET');
    expect(source).toContain('process.env.NEXUS_TOKEN');
    // No dialect marker: pi consumes the parameters as typebox-shaped literals.
    expect(JSON.parse(source.match(/const TOOLS = (\[[\s\S]*?\]);/)?.[1] ?? '[]')).toHaveLength(
      Object.keys(collaborationTools).length,
    );
    expect(source).not.toContain('"$schema"');
  });

  it('is owner-only like every other file that can carry a token path', () => {
    const path = writePiBridge(tempDir());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rewrites an existing bridge on restart', () => {
    const dir = tempDir();
    const first = writePiBridge(dir);
    const second = writePiBridge(dir);
    expect(second).toBe(first);
  });
});

type RegisteredTool = {
  name: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

/** Loads the generated extension with a stub pi and returns its tools. */
async function loadBridge(path: string): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>();
  const mod = (await import(/* @vite-ignore */ path)) as {
    default: (pi: { registerTool: (def: RegisteredTool) => void }) => void;
  };
  mod.default({ registerTool: (def) => tools.set(def.name, def) });
  return tools;
}

describe('generated bridge over the socket', () => {
  it('authenticates, forwards the call and returns the result', async () => {
    const dir = tempDir();
    const socketPath = join(dir, 'nexus.sock');
    const received: Array<{ method?: string; params?: unknown }> = [];
    const { createServer } = await import('node:net');
    const server = createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          const message = JSON.parse(line) as { id: number; method?: string; params?: unknown };
          received.push(message);
          const result = message.method === 'auth' ? {} : { messageId: 'm1', state: 'delivered' };
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const oldSocket = process.env.NEXUS_SOCKET;
    const oldToken = process.env.NEXUS_TOKEN;
    process.env.NEXUS_SOCKET = socketPath;
    process.env.NEXUS_TOKEN = 'tok-1';
    try {
      const tools = await loadBridge(writePiBridge(dir));
      expect([...tools.keys()].sort()).toEqual(Object.keys(collaborationTools).sort());
      const send = tools.get('send_message');
      if (!send) throw new Error('send_message not registered');
      const result = await send.execute('call-1', { text: '完成了', to: 'parent' });
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
        messageId: 'm1',
        state: 'delivered',
      });
      expect(received[0]).toMatchObject({ method: 'auth', params: { token: 'tok-1' } });
      expect(received[1]).toMatchObject({
        method: 'collab.send_message',
        params: { text: '完成了', to: 'parent' },
      });
    } finally {
      if (oldSocket === undefined) delete process.env.NEXUS_SOCKET;
      else process.env.NEXUS_SOCKET = oldSocket;
      if (oldToken === undefined) delete process.env.NEXUS_TOKEN;
      else process.env.NEXUS_TOKEN = oldToken;
      server.close();
    }
  });

  it('rejects when the channel is not configured', async () => {
    const dir = tempDir();
    const oldSocket = process.env.NEXUS_SOCKET;
    const oldToken = process.env.NEXUS_TOKEN;
    delete process.env.NEXUS_SOCKET;
    delete process.env.NEXUS_TOKEN;
    try {
      const tools = await loadBridge(writePiBridge(dir));
      const tool = tools.get('read_task_context');
      if (!tool) throw new Error('read_task_context not registered');
      await expect(tool.execute('call-1', {})).rejects.toThrow('协作通道未配置');
    } finally {
      if (oldSocket !== undefined) process.env.NEXUS_SOCKET = oldSocket;
      if (oldToken !== undefined) process.env.NEXUS_TOKEN = oldToken;
    }
  });
});
