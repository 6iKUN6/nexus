/**
 * Environment for harness processes: the parent's env, minus variables that
 * would make a Node-based CLI behave like Electron, plus the login-shell PATH
 * (GUI apps don't inherit it on macOS).
 */
const DROP = /^(ELECTRON_|NODE_OPTIONS$|NODE_CHANNEL_FD$|VITE_|NEXUS_)/;

export function harnessEnvironment(
  pathValue: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !DROP.test(key)) env[key] = value;
  }
  env.PATH = pathValue;
  return env;
}
