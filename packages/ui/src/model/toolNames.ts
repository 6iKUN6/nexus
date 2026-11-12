/**
 * Display names for tool calls. Harnesses report raw tool names; MCP tools
 * arrive as `mcp__<server>__<tool>` (e.g. mcp__playwright__browser_navigate),
 * which is illegible in the timeline. Split the prefix so the card shows the
 * server and a readable action instead.
 */
export function toolDisplayName(name: string): { server: string | null; label: string } {
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (mcp && mcp[1] && mcp[2]) {
    return { server: mcp[1], label: mcp[2].replaceAll('_', ' ') };
  }
  return { server: null, label: name };
}
