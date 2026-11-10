import type { HarnessId } from '@nexus/protocol';

export type HarnessDefinition = {
  id: HarnessId;
  displayName: string;
  binaryName: string;
  versionArgs: string[];
};

/** Harnesses detected on startup. Order is the display order. */
/** Display name for a harness id, including the dev-only fake harness. */
export function harnessLabel(id: HarnessId): string {
  if (id === 'fake') return 'Fake';
  return HARNESS_CATALOG.find((def) => def.id === id)?.displayName ?? id;
}

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
