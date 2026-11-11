/**
 * Scrubs secrets out of text before it leaves the app in a diagnostic bundle.
 * Event payloads can contain anything the user pasted (API keys, .env dumps),
 * so redaction is a mandatory step of the export path, not an option.
 */

export type RedactionResult = {
  text: string;
  /** Hits from token-shaped patterns. */
  secrets: number;
  /** Hits from `.env`-style KEY=value assignments. */
  envKeys: number;
};

const REDACTED = '<redacted>';

// Order matters: the private-key block runs first so its header/footer lines
// are not double-counted by the generic token patterns.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

// ENV assignments whose name implies a secret: API_KEY=..., DB_PASSWORD='...'.
const ENV_KEY_PATTERN =
  /(^|\n)([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)("?)[^\n"']+\3/gim;

export function redactSecrets(text: string): RedactionResult {
  let secrets = 0;
  let envKeys = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      secrets += 1;
      return REDACTED;
    });
  }
  out = out.replace(ENV_KEY_PATTERN, (_match, prefix: string, key: string) => {
    envKeys += 1;
    return `${prefix}${key}${REDACTED}`;
  });
  return { text: out, secrets, envKeys };
}

/** Replaces the user's home directory with `~` so paths can be shared safely. */
export function redactHome(text: string, homeDir: string): string {
  return homeDir ? text.split(homeDir).join('~') : text;
}
