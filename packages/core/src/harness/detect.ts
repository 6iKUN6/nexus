import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { HarnessInfo } from '@nexus/protocol';
import { HARNESS_CATALOG, type HarnessDefinition } from './catalog';

export type DetectDeps = {
  /** PATH used both for lookup and for running `--version` (scripts need `node` on PATH). */
  pathValue: string;
  isExecutable(file: string): Promise<boolean>;
  /** Resolves with combined stdout/stderr; rejects on non-zero exit or timeout. */
  runVersion(file: string, args: string[], pathValue: string): Promise<string>;
};

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export function parseVersion(output: string): string | null {
  return VERSION_PATTERN.exec(output)?.[0] ?? null;
}

export async function findExecutable(
  binaryName: string,
  deps: Pick<DetectDeps, 'pathValue' | 'isExecutable'>,
): Promise<string | null> {
  for (const dir of deps.pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binaryName);
    if (await deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function detectHarness(
  def: HarnessDefinition,
  deps: DetectDeps,
): Promise<HarnessInfo> {
  const base = {
    id: def.id,
    displayName: def.displayName,
    binaryName: def.binaryName,
    // Auth is only known once an adapter probe runs (M0/M1); never guess it here.
    auth: 'unknown' as const,
    // Set by core, which knows which adapters exist.
    chatSupported: false,
  };

  const executablePath = await findExecutable(def.binaryName, deps);
  if (!executablePath) {
    return { ...base, installed: false, executablePath: null, version: null, problem: null };
  }

  try {
    const output = await deps.runVersion(executablePath, def.versionArgs, deps.pathValue);
    const version = parseVersion(output);
    return {
      ...base,
      installed: true,
      executablePath,
      version,
      problem: version ? null : `无法从版本输出中识别版本号：${output.trim().slice(0, 120)}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      installed: true,
      executablePath,
      version: null,
      problem: `执行 ${def.binaryName} ${def.versionArgs.join(' ')} 失败：${reason.slice(0, 200)}`,
    };
  }
}

export function detectHarnesses(deps: DetectDeps): Promise<HarnessInfo[]> {
  return Promise.all(HARNESS_CATALOG.map((def) => detectHarness(def, deps)));
}

export const nodeDetectDeps = (pathValue: string): DetectDeps => ({
  pathValue,
  async isExecutable(file) {
    try {
      await access(file, constants.X_OK);
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  },
  runVersion(file, args, path) {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: 10_000, encoding: 'utf8', env: { ...process.env, PATH: path, NO_COLOR: '1' } },
        (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}\n${stderr}`)),
      );
    });
  },
});
