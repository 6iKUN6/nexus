import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHelperShim } from './shim';

const run = promisify(execFile);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe('writeHelperShim', () => {
  it('runs the helper with the given runner and forwards argv and env', async () => {
    // A space in the directory catches the quoting mistakes that would break
    // the launcher on a real user's machine.
    const dir = mkdtempSync(join(tmpdir(), 'nexus helper-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'helper script.js');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), flag: process.env.NEXUS_TEST_FLAG }));',
    );
    const shim = join(dir, 'bin', 'nexus-helper');
    writeHelperShim(shim, { command: process.execPath, env: { NEXUS_TEST_FLAG: 'on' } }, script);

    const { stdout } = await run(shim, ['mcp', '--probe']);
    expect(JSON.parse(stdout)).toEqual({ argv: ['mcp', '--probe'], flag: 'on' });
  });
});
