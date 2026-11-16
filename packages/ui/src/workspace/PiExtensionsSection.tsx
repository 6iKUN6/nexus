import { Button, Input, Message, Popconfirm } from '@arco-design/web-react';
import { IconDelete } from '@arco-design/web-react/icon';
import type { PiExtension } from '@nexus/protocol';
import { useEffect, useState } from 'react';

/**
 * pi user-scope extensions (D23, ADR 0020): the `packages` array of
 * ~/.pi/agent/settings.json, installed and removed through the pi CLI.
 * Project-local extensions live in throwaway worktrees and stay
 * terminal-managed, so they are deliberately not shown here.
 */
export function PiExtensionsSection({
  state,
  onRefresh,
  onInstall,
  onRemove,
}: {
  /** null until the first list resolves. */
  state: { extensions: PiExtension[]; piInstalled: boolean } | null;
  onRefresh: () => Promise<void>;
  onInstall: (source: string) => Promise<void>;
  onRemove: (source: string) => Promise<void>;
}) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  // Mount-only load; install/remove already refresh the list afterwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onRefresh is an inline prop
  useEffect(() => {
    void onRefresh().catch(() => {});
  }, []);

  if (!state?.piInstalled) return null;
  const extensions = state.extensions;

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    action()
      .catch((error: unknown) =>
        Message.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  };

  const install = () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    run(async () => {
      await onInstall(trimmed);
      setSource('');
    });
  };

  return (
    <div className="mt-2 border-0 border-t border-line-1 pt-2">
      <span className="text-[11px] text-fg-3">拓展（用户级）</span>
      {extensions.length === 0 ? (
        <p className="m-0 mt-1 text-[11px] text-fg-4">还没有安装拓展</p>
      ) : (
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
          {extensions.map((extension) => (
            <li key={extension.source} className="flex items-center gap-1">
              <span
                className="nx-selectable min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2"
                title={extension.source}
              >
                {extension.source}
              </span>
              <Popconfirm
                title={`卸载 ${extension.source}？`}
                okText="卸载"
                cancelText="取消"
                onOk={() => run(() => onRemove(extension.source))}
              >
                <Button
                  size="mini"
                  type="text"
                  icon={<IconDelete />}
                  aria-label={`卸载 ${extension.source}`}
                  disabled={busy}
                />
              </Popconfirm>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <Input
          size="mini"
          value={source}
          placeholder="npm:包名 / git:仓库 / 本地路径"
          aria-label="拓展来源"
          disabled={busy}
          onChange={setSource}
          onPressEnter={install}
        />
        <Button
          size="mini"
          disabled={!source.trim() || busy}
          loading={busy}
          aria-label="安装拓展"
          onClick={install}
        >
          安装
        </Button>
      </div>
    </div>
  );
}
