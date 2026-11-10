import { join } from 'node:path';
import { createClaudeAdapter } from '@nexus/adapter-claude';
import { createCodexAdapter } from '@nexus/adapter-codex';
import { createFakeAdapter, type FakeStep } from '@nexus/adapter-fake';
import { createPiAdapter } from '@nexus/adapter-pi';
import { createCore } from '@nexus/core';
import type { AgentAdapter, HarnessId, RpcPort } from '@nexus/protocol';
import type { MessagePortMain } from 'electron';

/**
 * Entry of the core utility process. Thin glue only: it picks adapters,
 * adapts Electron MessagePortMain to the transport-agnostic RpcPort and hands
 * ports to core.
 */

const dataDir = process.env.NEXUS_DATA_DIR;
if (!dataDir) throw new Error('NEXUS_DATA_DIR is not set');

/** Development harness: exercises streaming, tools and permissions without spending quota. */
const demoScript = (prompt: string): FakeStep[] => [
  { kind: 'thinking', text: '先搜一下相关代码，再让子代理看入口文件，最后写入笔记。' },
  { kind: 'text', text: '好的，我先看一下项目结构。' },
  { kind: 'tool', name: 'Grep', input: { pattern: prompt.slice(0, 20) }, summary: '找到 3 处匹配' },
  {
    kind: 'tool',
    name: 'Task',
    input: { description: '探索项目入口' },
    summary: '子代理完成：入口在 src/main.ts',
    children: [
      { name: 'Glob', input: { pattern: 'src/**/*.ts' }, summary: '12 个文件' },
      { name: 'Read', input: { file_path: 'src/main.ts' }, summary: '读取 80 行' },
    ],
  },
  { kind: 'permission', description: '写入 notes.md' },
  { kind: 'text', text: `\n\n已完成：${prompt}` },
];

const adapters: Partial<Record<HarnessId, AgentAdapter>> = {
  'claude-code': createClaudeAdapter(),
  codex: createCodexAdapter(),
  pi: createPiAdapter(),
  ...(process.env.NEXUS_FAKE_HARNESS === '1'
    ? { fake: createFakeAdapter({ script: demoScript, stepDelayMs: 350 }) }
    : {}),
};

const core = createCore({
  version: process.env.NEXUS_VERSION ?? '0.0.0',
  databasePath: join(dataDir, 'nexus.sqlite'),
  adapters,
});

function toRpcPort(port: MessagePortMain): RpcPort {
  return {
    send: (message) => port.postMessage(message),
    onMessage(listener) {
      const handler = (event: { data: unknown }) => listener(event.data);
      port.on('message', handler);
      return () => port.off('message', handler);
    },
  };
}

process.parentPort.on('message', (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type === 'nexus:shutdown') {
    void core.dispose().finally(() => process.exit(0));
    return;
  }
  const port = event.ports[0];
  if (data?.type !== 'nexus:connect' || !port) return;

  const detach = core.attach(toRpcPort(port));
  port.on('close', detach);
  port.start();
});
