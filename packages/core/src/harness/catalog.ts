import type { HarnessId } from '@nexus/protocol';

export type HarnessDefinition = {
  id: HarnessId;
  displayName: string;
  binaryName: string;
  versionArgs: string[];
};

/** Harnesses detected on startup. Order is the display order. */
export const HARNESS_CATALOG: readonly HarnessDefinition[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    binaryName: 'claude',
    versionArgs: ['--version'],
  },
  { id: 'codex', displayName: 'Codex', binaryName: 'codex', versionArgs: ['--version'] },
  { id: 'pi', displayName: 'pi', binaryName: 'pi', versionArgs: ['--version'] },
  { id: 'dsh', displayName: 'DeepSeek Harness', binaryName: 'dsh', versionArgs: ['--version'] },
];
