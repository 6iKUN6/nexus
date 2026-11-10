// Pseudo harness for testing the probe runner itself (no model, no quota).
// Emits JSON lines like a real harness; on "cancel" prompts it starts a child
// that ignores SIGINT, so the runner's escalation and orphan detection run.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? '';
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex === -1 ? randomUUID() : args[resumeIndex + 1];
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

emit({ type: 'system', subtype: 'init', session_id: sessionId });
if (prompt.includes('sleep')) {
  // Child in the same process group that ignores SIGINT, like a stubborn tool process.
  spawn('/bin/sh', ['-c', 'trap "" INT; sleep 60'], { stdio: 'ignore' });
  emit({ type: 'tool', item: { type: 'command', command: 'sleep 30' } });
  setInterval(() => emit({ type: 'heartbeat' }), 1000);
} else {
  for (const word of prompt.split(' ')) emit({ type: 'text', delta: `${word} ` });
  if (prompt.includes('code word I asked'))
    emit({ type: 'text', delta: resumeIndex === -1 ? 'no memory' : 'AZURE-17' });
  if (prompt.includes('PONG')) emit({ type: 'text', delta: 'PONG' });
  emit({ type: 'result', session_id: sessionId });
}
