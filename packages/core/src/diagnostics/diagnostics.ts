import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, HarnessInfo } from '@nexus/protocol';
import type { Store } from '../store/store';
import { recentLogs } from './logBuffer';
import { redactHome, redactSecrets } from './redact';

/**
 * Assembles a user-initiated diagnostic bundle: a plain directory (no archive
 * dependency) the user can inspect before sharing. Secrets are scrubbed on
 * the way out (redact.ts); only redaction counts are reported, never content.
 */

export type DiagnosticsDeps = {
  store: Store;
  version: string;
  /** Fresh harness detection results (probe included). */
  harnesses: () => Promise<HarnessInfo[]>;
  /** Parent directory for bundles; injectable so tests stay in tmp. */
  diagnosticsDir: string;
  maxConcurrentRuns: number;
  databasePath: string;
  homeDir?: string;
  now?: () => number;
};

export type DiagnosticsResult = {
  path: string;
  redactions: { events: number; envKeys: number };
};

export async function exportDiagnostics(
  deps: DiagnosticsDeps,
  conversationId?: string,
): Promise<DiagnosticsResult> {
  const now = deps.now ?? Date.now;
  const home = deps.homeDir ?? homedir();
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const dir = join(deps.diagnosticsDir, `nexus-diagnostics-${stamp}`);
  mkdirSync(join(dir, 'conversations'), { recursive: true });

  const redactions = { events: 0, envKeys: 0 };
  const scrub = (text: string): string => {
    const result = redactSecrets(redactHome(text, home));
    redactions.events += result.secrets;
    redactions.envKeys += result.envKeys;
    return result.text;
  };

  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        app: 'nexus',
        version: deps.version,
        platform: process.platform,
        arch: process.arch,
        exportedAt: new Date(now()).toISOString(),
        schemaVersion: deps.store.schemaVersion(),
      },
      null,
      2,
    ),
  );

  const harnesses = (await deps.harnesses()).map((h) => ({
    ...h,
    executablePath: h.executablePath ? redactHome(h.executablePath, home) : null,
  }));
  writeFileSync(join(dir, 'harnesses.json'), JSON.stringify(harnesses, null, 2));

  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        maxConcurrentRuns: deps.maxConcurrentRuns,
        databasePath: redactHome(deps.databasePath, home),
      },
      null,
      2,
    ),
  );

  const conversations = conversationId
    ? [deps.store.getConversation(conversationId)].filter((c): c is Conversation => c !== null)
    : deps.store.listConversations();
  for (const conversation of conversations) {
    const lines = deps.store
      .listEvents(conversation.id, 0)
      .map((event) => scrub(JSON.stringify(event)));
    writeFileSync(join(dir, 'conversations', `${conversation.id}.jsonl`), `${lines.join('\n')}\n`);
  }

  writeFileSync(join(dir, 'logs.txt'), `${scrub(recentLogs())}\n`);

  return { path: dir, redactions };
}
