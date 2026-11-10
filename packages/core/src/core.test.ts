import { createFakeAdapter } from '@nexus/adapter-fake';
import {
  type ConversationEvent,
  createMemoryPortPair,
  createRpcClient,
  type HarnessInfo,
} from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { createCore } from './core';

const pi: HarnessInfo = {
  id: 'pi',
  displayName: 'pi',
  binaryName: 'pi',
  installed: true,
  executablePath: '/bin/pi',
  version: '0.84.2',
  auth: 'unknown',
  problem: null,
  chatSupported: false,
};

function connect(detect: () => Promise<HarnessInfo[]>, adapters = {}) {
  let clock = 1_000;
  const core = createCore({
    version: '0.0.0-test',
    databasePath: ':memory:',
    adapters,
    detectHarnesses: detect,
    resolvePath: async () => '/bin',
    now: () => clock,
  });
  const [clientPort, corePort] = createMemoryPortPair();
  core.attach(corePort);
  return {
    core,
    client: createRpcClient(clientPort),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('core', () => {
  it('answers ping with version and uptime', async () => {
    const { client, advance } = connect(async () => []);
    advance(250);
    await expect(client.request('system.ping', {})).resolves.toEqual({
      coreVersion: '0.0.0-test',
      uptimeMs: 250,
    });
  });

  it('caches harness detection until refresh is requested', async () => {
    let calls = 0;
    const { client } = connect(async () => {
      calls++;
      return [pi];
    });
    await client.request('harness.list', {});
    await client.request('harness.list', {});
    expect(calls).toBe(1);
    const refreshed = await client.request('harness.list', { refresh: true });
    expect(calls).toBe(2);
    expect(refreshed.harnesses).toEqual([pi]);
  });

  it('does not cache a failed detection', async () => {
    let calls = 0;
    const { client } = connect(async () => {
      calls++;
      if (calls === 1) throw new Error('disk on fire');
      return [pi];
    });
    await expect(client.request('harness.list', {})).rejects.toThrow('disk on fire');
    await expect(client.request('harness.list', {})).resolves.toEqual({ harnesses: [pi] });
  });

  it('marks installed harnesses with an adapter as chat-capable and lists the fake harness', async () => {
    const { client } = connect(async () => [pi], {
      pi: createFakeAdapter(),
      fake: createFakeAdapter(),
    });
    const { harnesses } = await client.request('harness.list', {});
    expect(harnesses.find((h) => h.id === 'pi')?.chatSupported).toBe(true);
    expect(harnesses.find((h) => h.id === 'fake')).toMatchObject({ chatSupported: true });
  });

  it('merges adapter probe results (capabilities, limitations, auth) into harness info', async () => {
    const codex: HarnessInfo = { ...pi, id: 'codex', displayName: 'Codex', binaryName: 'codex' };
    const { client } = connect(async () => [pi, codex], { pi: createFakeAdapter() });
    const { harnesses } = await client.request('harness.list', {});
    const probed = harnesses.find((h) => h.id === 'pi');
    expect(probed).toMatchObject({
      chatSupported: true,
      version: '0.84.2', // detection wins over the adapter's static probe
      auth: 'authenticated', // adapter probe wins over 'unknown'
      limitations: ['Scripted responses only.'],
    });
    expect(probed?.capabilities).toMatchObject({ streaming: true, permissions: true });
    // No adapter: chat unsupported and no capabilities are reported.
    expect(harnesses.find((h) => h.id === 'codex')).toMatchObject({ chatSupported: false });
    expect(harnesses.find((h) => h.id === 'codex')?.capabilities).toBeUndefined();
  });

  it('runs a conversation end to end over RPC and pushes events to the client', async () => {
    const { client } = connect(async () => [], { fake: createFakeAdapter() });
    const pushed: ConversationEvent[] = [];
    client.onNotification('conversation.event', (event) => pushed.push(event));
    const { conversation } = await client.request('conversation.create', {
      harnessId: 'fake',
      cwd: process.cwd(),
    });
    await client.request('conversation.send', { conversationId: conversation.id, text: 'hello' });
    await expect.poll(() => pushed.at(-1)?.body.type).toBe('run.completed');

    const { events } = await client.request('conversation.events', {
      conversationId: conversation.id,
    });
    expect(events.map((e) => e.seq)).toEqual(pushed.map((e) => e.seq));
    expect(events[0]?.body).toMatchObject({ type: 'user.message', text: 'hello' });
  });
});
