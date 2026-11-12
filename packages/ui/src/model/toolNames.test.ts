import { describe, expect, it } from 'vitest';
import { toolDisplayName } from './toolNames';

describe('toolDisplayName', () => {
  it('splits MCP names into server and readable action', () => {
    expect(toolDisplayName('mcp__playwright__browser_navigate')).toEqual({
      server: 'playwright',
      label: 'browser navigate',
    });
  });

  it('passes built-in tool names through', () => {
    expect(toolDisplayName('Bash')).toEqual({ server: null, label: 'Bash' });
  });
});
