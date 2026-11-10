// protocol is compiled without DOM or Node typings so it stays environment-free.
// These timer globals exist in every runtime we target (Node, Electron, browsers).
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare const console: { error(...args: unknown[]): void };
