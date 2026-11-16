import { defaultShellRunner, type ShellRunner } from './loginShellPath';

/**
 * GUI apps inherit a minimal environment, so API keys exported from
 * ~/.zshrc are invisible to MCP servers Nexus spawns. D23 (ADR 0020) stores
 * `${VAR}` placeholders instead of secrets and resolves them against the
 * user's login-shell environment, captured once at startup. The captured
 * values live in memory only.
 */

const START = '__NEXUS_ENV_START__';
const END = '__NEXUS_ENV_END__';

/** Parses `env`-style output between the markers; values may contain '='. */
export function extractMarkedEnv(output: string): Record<string, string> | null {
  const start = output.lastIndexOf(START);
  if (start === -1) return null;
  const end = output.indexOf(END, start + START.length);
  if (end === -1) return null;
  const body = output.slice(start + START.length, end);
  const env: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

export type ResolveEnvOptions = {
  shell?: string | undefined;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  run?: ShellRunner;
};

/**
 * The login-shell environment merged over the process environment: the shell
 * wins (it is where users put their keys), process env is the fallback.
 * Returns just process.env on Windows or when the shell fails.
 */
export async function resolveLoginShellEnv(
  options: ResolveEnvOptions = {},
): Promise<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return base;

  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh';
  const run = options.run ?? defaultShellRunner;
  // -i and -l so both .zprofile and .zshrc are sourced, same as the PATH probe.
  const script = `printf '%s' '${START}'; env; printf '%s' '${END}'`;
  try {
    const login = extractMarkedEnv(await run(shell, ['-ilc', script], options.timeoutMs ?? 5_000));
    return login ? { ...base, ...login } : base;
  } catch {
    return base;
  }
}
