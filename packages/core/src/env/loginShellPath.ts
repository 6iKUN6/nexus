import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * macOS apps launched from Finder/Dock inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so CLIs installed through Homebrew, nvm,
 * npm -g etc. are invisible. We ask the user's login shell for its PATH once
 * and merge it with well-known install locations.
 */

const START = '__NEXUS_PATH_START__';
const END = '__NEXUS_PATH_END__';

export function extractMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(START);
  if (start === -1) return null;
  const end = output.indexOf(END, start + START.length);
  if (end === -1) return null;
  const value = output.slice(start + START.length, end).trim();
  return value.length > 0 ? value : null;
}

/** Joins PATH strings, keeping the first occurrence of each directory. */
export function mergePathValues(...values: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const value of values) {
    for (const dir of (value ?? '').split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
    }
  }
  return dirs.join(delimiter);
}

export function wellKnownBinDirs(home = homedir()): string {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.cargo/bin'),
    '/usr/bin',
    '/bin',
  ].join(delimiter);
}

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultShellRunner: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      shell,
      args,
      { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export type ResolvePathOptions = {
  shell?: string | undefined;
  currentPath?: string | undefined;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  run?: ShellRunner;
};

export async function resolveLoginShellPath(options: ResolvePathOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const currentPath = options.currentPath ?? process.env.PATH;
  if (platform === 'win32') return mergePathValues(currentPath);

  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh';
  const run = options.run ?? defaultShellRunner;
  const script = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;

  let loginPath: string | null = null;
  try {
    // -i and -l so both .zprofile and .zshrc (where nvm usually lives) are sourced.
    loginPath = extractMarkedPath(await run(shell, ['-ilc', script], options.timeoutMs ?? 5_000));
  } catch {
    loginPath = null;
  }
  return mergePathValues(loginPath, currentPath, wellKnownBinDirs());
}
