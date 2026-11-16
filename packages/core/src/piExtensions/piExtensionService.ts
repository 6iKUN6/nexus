import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RpcError } from '@nexus/protocol';

/**
 * pi extension management (D23, ADR 0020). The list is just the `packages`
 * array in ~/.pi/agent/settings.json; install/remove shell out to the pi CLI
 * with an argv array (never a shell string). User scope only — project-local
 * settings live in throwaway worktrees.
 */

export const PiExtensionErrorCode = {
  PiNotInstalled: 4050,
  CliFailed: 4051,
} as const;

export type PiExtensionDeps = {
  /** Absolute path of the pi CLI, from harness detection. */
  piPath: () => Promise<string | null>;
  homeDir?: string;
  run?: (executable: string, args: string[]) => Promise<{ code: number; output: string }>;
  readSettings?: () => Promise<string | null>;
};

const defaultRun = (executable: string, args: string[]) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      executable,
      args,
      { timeout: 120_000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, output: `${stdout}${stderr}`.trim() });
      },
    );
  });

export class PiExtensionService {
  constructor(private readonly deps: PiExtensionDeps) {}

  private async settingsPath(): Promise<string> {
    return join(this.deps.homeDir ?? homedir(), '.pi', 'agent', 'settings.json');
  }

  private async readPackages(): Promise<string[]> {
    const read =
      this.deps.readSettings ??
      (async () => {
        try {
          return await readFile(await this.settingsPath(), 'utf8');
        } catch {
          return null;
        }
      });
    const raw = await read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return [];
      const packages = (parsed as { packages?: unknown }).packages;
      return Array.isArray(packages)
        ? packages.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      return [];
    }
  }

  async list(): Promise<{ extensions: Array<{ source: string }>; piInstalled: boolean }> {
    const piInstalled = (await this.deps.piPath()) !== null;
    const packages = await this.readPackages();
    return { extensions: packages.map((source) => ({ source })), piInstalled };
  }

  async install(source: string): Promise<void> {
    await this.runCli(['install', source]);
  }

  async remove(source: string): Promise<boolean> {
    const before = await this.readPackages();
    if (!before.includes(source)) return false;
    await this.runCli(['remove', source]);
    return true;
  }

  private async runCli(args: string[]): Promise<void> {
    const executable = await this.deps.piPath();
    if (!executable) {
      throw new RpcError(PiExtensionErrorCode.PiNotInstalled, '未检测到 pi，无法管理拓展');
    }
    const run = this.deps.run ?? defaultRun;
    const { code, output } = await run(executable, args);
    if (code !== 0) {
      const tail = output.split('\n').slice(-3).join('\n');
      throw new RpcError(
        PiExtensionErrorCode.CliFailed,
        `pi ${args[0]} 失败${tail ? `：${tail}` : ''}`,
      );
    }
  }
}
