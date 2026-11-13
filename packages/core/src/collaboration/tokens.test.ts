import { describe, expect, it } from 'vitest';
import { SessionTokens } from './tokens';

describe('SessionTokens', () => {
  it('binds a token to its conversation and revokes it', () => {
    const tokens = new SessionTokens();
    const token = tokens.issue('conversation-a');
    expect(tokens.resolve(token)).toBe('conversation-a');

    tokens.revoke(token);
    expect(tokens.resolve(token)).toBeNull();
  });

  it('revokes every token of a conversation without touching others', () => {
    const tokens = new SessionTokens();
    const first = tokens.issue('a');
    const second = tokens.issue('a');
    const other = tokens.issue('b');

    tokens.revokeConversation('a');
    expect(tokens.resolve(first)).toBeNull();
    expect(tokens.resolve(second)).toBeNull();
    expect(tokens.resolve(other)).toBe('b');
  });
});
