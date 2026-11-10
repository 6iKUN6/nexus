import type { Scenario } from './types.ts';

/** Scenarios from 开发落地计划.md §9.5. Only `help` is free. */
export const SCENARIOS: Scenario[] = [
  {
    id: 'help',
    title: 'CLI surface: --version / --help (no model call)',
    costsQuota: false,
    turns: [],
    timeoutMs: 30_000,
  },
  {
    id: 'basic',
    title: 'Single turn, structured streaming output',
    costsQuota: true,
    turns: [{ prompt: 'Reply with exactly the word PONG and nothing else.' }],
    expect: 'PONG',
    timeoutMs: 120_000,
  },
  {
    id: 'chinese',
    title: 'Chinese + long output (streaming chunking, encoding)',
    costsQuota: true,
    turns: [
      {
        prompt:
          '不要使用任何工具。用中文写一段约 600 字的说明，介绍 git worktree 的用途，最后一行单独写“完毕”。',
      },
    ],
    expect: '完毕',
    timeoutMs: 180_000,
  },
  {
    id: 'tool',
    title: 'Tool call: read a file in cwd',
    costsQuota: true,
    turns: [
      {
        prompt:
          'Read the file hello.txt in the current directory and reply with its first line only.',
      },
    ],
    expect: 'NEXUS-PROBE-LINE-1',
    timeoutMs: 180_000,
  },
  {
    id: 'permission',
    title: 'Write that needs approval (observe request / denial events)',
    costsQuota: true,
    turns: [
      {
        prompt: 'Create a file named created.txt in the current directory containing the text hi.',
        permissionMode: 'none',
      },
    ],
    timeoutMs: 180_000,
  },
  {
    id: 'cancel',
    title: 'Cancel mid-run (SIGINT to process group) and check for orphans',
    costsQuota: true,
    turns: [
      {
        prompt:
          'Run the shell command `sleep 30 && echo done` in the current directory, then tell me what it printed.',
      },
    ],
    cancel: { afterLines: 1, delayMs: 4_000 },
    timeoutMs: 120_000,
  },
  {
    id: 'resume',
    title: 'Two turns in the same session',
    costsQuota: true,
    turns: [
      { prompt: 'Remember this code word: AZURE-17. Reply with OK only.' },
      { prompt: 'What was the code word I asked you to remember? Reply with the code word only.' },
    ],
    expect: 'AZURE-17',
    timeoutMs: 180_000,
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
