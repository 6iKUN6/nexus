import type { Conversation, ConversationEvent } from '@nexus/protocol';
import { describe, expect, it } from 'vitest';
import { suggestHandoff } from './suggest';

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: '修复登录跳转',
  harnessId: 'claude-code',
  cwd: '/repo',
  isolation: 'direct',
  baseCwd: null,
  externalSessionId: null,
  ownerVersion: 1,
  state: 'idle',
  lastSeq: 0,
  preview: '',
  goal: null,
  fallbackHarnessId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

let seq = 0;
const event = (body: ConversationEvent['body']): ConversationEvent => ({
  conversationId: 'c1',
  seq: ++seq,
  at: seq,
  body,
});

const supported = (id: string) => id === 'codex' || id === 'pi';
const anySupported = () => true;

describe('suggestHandoff', () => {
  it('derives the goal from the first user message when none is pinned', () => {
    const result = suggestHandoff(
      conversation(),
      [
        event({ type: 'user.message', messageId: 'm1', text: '修好登录后的跳转' }),
        event({ type: 'user.message', messageId: 'm2', text: '另外补个测试' }),
      ],
      anySupported,
    );
    expect(result.goal).toBe('修好登录后的跳转');
    expect(result.nextAction).toContain('最近的用户要求：另外补个测试');
  });

  it('prefers the explicit goal and skips core-injected prompts', () => {
    const result = suggestHandoff(
      conversation({ goal: '任务：修好登录' }),
      [
        event({ type: 'user.message', messageId: 'core-delegate-1', text: '委派说明' }),
        event({ type: 'user.message', messageId: 'm1', text: '真正的需求' }),
      ],
      anySupported,
    );
    expect(result.goal).toBe('任务：修好登录');
    // The requirement quote also skips the core prompt.
    expect(result.nextAction).toContain('真正的需求');
    expect(result.nextAction).not.toContain('委派说明');
  });

  it('falls back to the title when there are no user messages', () => {
    expect(suggestHandoff(conversation(), [], anySupported).goal).toBe('修复登录跳转');
  });

  it('mentions the last failure in the next action', () => {
    const result = suggestHandoff(
      conversation({ state: 'failed' }),
      [
        event({ type: 'user.message', messageId: 'm1', text: '修跳转' }),
        event({
          type: 'run.failed',
          runId: 'r1',
          error: { code: 'adapter_error', message: '额度不足' },
        }),
      ],
      anySupported,
    );
    expect(result.nextAction).toContain('从上次失败处继续');
    expect(result.nextAction).toContain('额度不足');
  });

  it('offers the fallback harness only when it is usable and differs', () => {
    expect(
      suggestHandoff(conversation({ fallbackHarnessId: 'codex' }), [], anySupported).toHarnessId,
    ).toBe('codex');
    // Same as the current owner would be an invalid receiver.
    expect(
      suggestHandoff(
        conversation({ harnessId: 'codex', fallbackHarnessId: 'codex' }),
        [],
        anySupported,
      ).toHarnessId,
    ).toBeNull();
    // Unsupported adapter (no adapter registered in this build).
    expect(
      suggestHandoff(conversation({ fallbackHarnessId: 'pi' }), [], supported).toHarnessId,
    ).toBe('pi');
    expect(
      suggestHandoff(conversation({ fallbackHarnessId: 'dsh' }), [], supported).toHarnessId,
    ).toBeNull();
  });
});
