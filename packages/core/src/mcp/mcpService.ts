import { randomUUID } from 'node:crypto';
import {
  MCP_ENV_PLACEHOLDER,
  type McpServerConfig,
  type McpServerInput,
  type McpServerRuntime,
  RpcError,
} from '@nexus/protocol';
import type { Store } from '../store/store';

/**
 * User-managed MCP servers (D23, ADR 0020). The store holds `${VAR}`
 * placeholders; resolution happens here against the login-shell environment
 * captured at startup, so secrets exist only in memory and in the spawned
 * server process.
 */

export type McpServiceDeps = {
  store: Store;
  /** Lazily captured login-shell environment (async, cached by core). */
  loginEnv: () => Promise<Record<string, string>>;
  now?: () => number;
  newId?: () => string;
};

export const McpErrorCode = {
  NotFound: 4040,
  WriteFailed: 4041,
} as const;

export type McpServerView = McpServerConfig & { unresolvedEnv: string[] };

/** Splits stored env into resolved values and the names that have no value. */
export function resolveEnvPlaceholders(
  env: Record<string, string>,
  lookup: Record<string, string>,
): { env: Record<string, string>; unresolved: string[] } {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = MCP_ENV_PLACEHOLDER.exec(value);
    if (!match) {
      resolved[key] = value;
      continue;
    }
    const name = match[1] ?? '';
    const found = lookup[name];
    if (found !== undefined) resolved[key] = found;
    else unresolved.push(name);
  }
  return { env: resolved, unresolved };
}

/** MCP server names must be safe tokens; derive from the id, never the name. */
export function runtimeKey(id: string): string {
  return `nx_${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
}

export class McpService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: McpServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  async list(): Promise<McpServerView[]> {
    const env = await this.deps.loginEnv();
    return this.deps.store.listMcpServers().map((row) => ({
      ...row,
      enabled: row.enabled === 1,
      unresolvedEnv: resolveEnvPlaceholders(row.env, env).unresolved,
    }));
  }

  async upsert(input: McpServerInput): Promise<McpServerConfig> {
    const now = this.now();
    const existing = input.id
      ? this.deps.store.listMcpServers().find((row) => row.id === input.id)
      : undefined;
    if (input.id && !existing) {
      throw new RpcError(McpErrorCode.NotFound, '这个 MCP server 不存在');
    }
    const row = {
      id: existing?.id ?? this.newId(),
      name: input.name,
      command: input.command,
      args: input.args,
      env: input.env,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      this.deps.store.upsertMcpServer({ ...row, enabled: row.enabled ? 1 : 0 });
    } catch (error) {
      throw new RpcError(McpErrorCode.WriteFailed, `保存失败：${String(error)}`);
    }
    return row;
  }

  remove(id: string): boolean {
    const removed = this.deps.store.deleteMcpServer(id);
    if (removed) {
      // Strip the id from every opt-in list so no conversation dangles.
      for (const conversation of this.deps.store.listConversations()) {
        if (!conversation.enabledMcpIds.includes(id)) continue;
        this.deps.store.updateConversation(
          conversation.id,
          { enabledMcpIds: conversation.enabledMcpIds.filter((x) => x !== id) },
          this.now(),
        );
      }
    }
    return removed;
  }

  /** Runtime injection set for a conversation: opted-in and globally enabled. */
  async runtimeFor(enabledIds: string[]): Promise<McpServerRuntime[]> {
    if (enabledIds.length === 0) return [];
    const env = await this.deps.loginEnv();
    return this.deps.store
      .listMcpServers()
      .filter((row) => row.enabled === 1 && enabledIds.includes(row.id))
      .map((row) => ({
        key: runtimeKey(row.id),
        command: row.command,
        args: row.args,
        env: resolveEnvPlaceholders(row.env, env).env,
      }));
  }
}
