/**
 * The in-app preview (ADR 0014) only loads local dev servers — it is not a
 * browser. One shared normalizer so the UI's "is this previewable" check and
 * the main process's navigation guard can never drift apart.
 *
 * Accepts what agents actually print ("localhost:5173", "127.0.0.1:3000/x")
 * and returns a canonical URL, or null for anything that is not a local
 * http(s) address.
 */

// WHATWG URL exists in every runtime Nexus targets (Node, Electron, browsers).
// Declared locally because protocol compiles without DOM or Node typings, and
// an ambient declaration would not travel to dependents compiling this file.
declare const URL: {
  new (input: string): { protocol: string; hostname: string; toString(): string };
};

function parseUrl(input: string) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/**
 * Any http(s) address, for the "open in the system browser" escape hatch: a
 * URL the preview pane must not load can still be offered for external
 * opening. Bare hosts get https:// (unlike normalizeLocalUrl, which assumes a
 * dev server and prefixes http://).
 */
export function normalizeHttpUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = parseUrl(withScheme);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

export function normalizeLocalUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = parseUrl(withScheme);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // WHATWG keeps the brackets on IPv6 hostnames.
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return url.toString();
  if (host === '127.0.0.1' || host === '[::1]') return url.toString();
  return null;
}
