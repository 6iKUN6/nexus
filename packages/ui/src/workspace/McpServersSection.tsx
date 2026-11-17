import { Button, Input, Modal, Popconfirm, Switch, Tooltip } from '@arco-design/web-react';
import { IconDelete, IconEdit, IconPlus, IconThunderbolt } from '@arco-design/web-react/icon';
import type { McpServerInput, McpServerView } from '@nexus/protocol';
import { useState } from 'react';

/**
 * User-managed MCP servers (D23, ADR 0020): a global list shown in the Agents
 * view. Servers are stdio commands the harness spawns with the conversation's
 * permissions; env values are ${VAR} placeholders resolved from the login
 * shell — secrets never touch the database.
 */

type Draft = {
  id: string | null;
  name: string;
  command: string;
  /** One argv element per line. */
  argsText: string;
  /** One KEY=value per line; value may be ${VAR}. */
  envText: string;
};

const EMPTY_DRAFT: Draft = { id: null, name: '', command: '', argsText: '', envText: '' };

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

export function McpServersSection({
  servers,
  onUpsert,
  onRemove,
}: {
  servers: McpServerView[];
  onUpsert: (input: McpServerInput) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = () => {
    if (!draft) return;
    const existing = draft.id ? servers.find((s) => s.id === draft.id) : undefined;
    onUpsert({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: parseLines(draft.argsText),
      env: parseEnv(draft.envText),
      enabled: existing?.enabled ?? true,
    });
    setDraft(null);
  };

  return (
    <section aria-label="MCP servers" className="px-2 pt-3">
      <div className="flex items-center gap-1.5 pb-1.5">
        <IconThunderbolt className="text-fg-3" />
        <span className="text-[13px] font-semibold text-fg-1">MCP servers</span>
        <Button
          size="mini"
          type="text"
          icon={<IconPlus />}
          aria-label="添加 MCP server"
          className="ml-auto"
          onClick={() => setDraft(EMPTY_DRAFT)}
        />
      </div>
      {servers.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-line-2 px-2.5 py-2 text-[11px] leading-relaxed text-fg-3">
          还没有 MCP server。添加后可在会话详情里按会话启用；仅支持 MCP 的 harness 会加载（pi
          不支持）。
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {servers.map((server) => (
            <li
              key={server.id}
              className="rounded-lg border border-line-1 bg-elevated px-2.5 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-fg-1">{server.name}</span>
                {server.unresolvedEnv.length > 0 && (
                  <Tooltip
                    content={`环境变量未找到：${server.unresolvedEnv.join('、')}（占位符保持原样，server 可能起不来）`}
                    mini
                  >
                    <span className="shrink-0 text-[11px] text-warn">缺环境变量</span>
                  </Tooltip>
                )}
                <Switch
                  size="small"
                  className="ml-auto"
                  checked={server.enabled}
                  aria-label={`启用 ${server.name}`}
                  onChange={(enabled) =>
                    onUpsert({
                      id: server.id,
                      name: server.name,
                      command: server.command,
                      args: server.args,
                      env: server.env,
                      enabled,
                    })
                  }
                />
              </div>
              <div className="mt-0.5 flex items-center gap-1">
                <span
                  className="nx-selectable min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3"
                  title={`${server.command} ${server.args.join(' ')}`}
                >
                  {server.command} {server.args.join(' ')}
                </span>
                <Button
                  size="mini"
                  type="text"
                  icon={<IconEdit />}
                  aria-label={`编辑 ${server.name}`}
                  onClick={() =>
                    setDraft({
                      id: server.id,
                      name: server.name,
                      command: server.command,
                      argsText: server.args.join('\n'),
                      envText: Object.entries(server.env)
                        .map(([key, value]) => `${key}=${value}`)
                        .join('\n'),
                    })
                  }
                />
                <Popconfirm
                  title={`删除 MCP server「${server.name}」？`}
                  content="已勾选它的会话会自动移除这项配置。"
                  okText="删除"
                  cancelText="取消"
                  onOk={() => onRemove(server.id)}
                >
                  <Button
                    size="mini"
                    type="text"
                    status="danger"
                    icon={<IconDelete />}
                    aria-label={`删除 ${server.name}`}
                  />
                </Popconfirm>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        title={draft?.id ? '编辑 MCP server' : '添加 MCP server'}
        visible={draft !== null}
        onCancel={() => setDraft(null)}
        onOk={save}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !draft?.name.trim() || !draft?.command.trim() }}
        unmountOnExit
      >
        {draft && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-2">名称</span>
              <Input
                value={draft.name}
                aria-label="server 名称"
                placeholder="如：文件系统"
                onChange={(name) => setDraft({ ...draft, name })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-2">命令（stdio）</span>
              <Input
                value={draft.command}
                aria-label="server 命令"
                placeholder="如：npx"
                className="font-mono"
                onChange={(command) => setDraft({ ...draft, command })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-2">参数（每行一个）</span>
              <Input.TextArea
                value={draft.argsText}
                aria-label="server 参数"
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                autoSize={{ minRows: 2, maxRows: 5 }}
                className="font-mono"
                onChange={(argsText) => setDraft({ ...draft, argsText })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-2">环境变量（每行 KEY=值）</span>
              <Input.TextArea
                value={draft.envText}
                aria-label="server 环境变量"
                // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder must show the literal ${VAR} syntax
                placeholder={'API_KEY=${MY_API_KEY}'}
                autoSize={{ minRows: 2, maxRows: 5 }}
                className="font-mono"
                onChange={(envText) => setDraft({ ...draft, envText })}
              />
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-fg-3">
              密钥写成 ${'{VAR}'} 占位符：值在会话启动时从登录 shell 环境读取，不会存入
              Nexus。server 进程以会话权限运行，请只添加你信任的 server。
            </p>
          </div>
        )}
      </Modal>
    </section>
  );
}
