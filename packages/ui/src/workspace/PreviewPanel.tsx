import { Button, Input, Tooltip } from '@arco-design/web-react';
import { IconClose, IconLaunch, IconPublic, IconRefresh } from '@arco-design/web-react/icon';
import { normalizeLocalUrl } from '@nexus/protocol';
import { useEffect, useRef } from 'react';

/**
 * In-app dev-server preview (ADR 0014). Deliberately simple: one URL per
 * conversation, localhost only (enforced again in the main process), plus an
 * escape hatch to the real browser. Not a general browser — no tabs, no
 * history, no navigation chrome beyond this bar.
 */

/** The DOM lib has no <webview>; only the two members Nexus actually uses. */
type WebviewElement = HTMLElement & { reload?: () => void };

function WebviewSurface({
  src,
  elementRef,
}: {
  src: string;
  elementRef: { current: WebviewElement | null };
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Created imperatively so the ui package never imports electron types; in
    // a plain browser this element is inert and callers gate on webPreview.
    const el = document.createElement('webview') as WebviewElement;
    el.setAttribute('src', src);
    // Persistent partition: dev-server cookies and localStorage survive restarts.
    el.setAttribute('partition', 'persist:preview');
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.border = '0';
    host.replaceChildren(el);
    elementRef.current = el;
    return () => {
      elementRef.current = null;
      host.replaceChildren();
    };
  }, [src, elementRef]);

  return <div ref={hostRef} className="min-h-0 flex-1 bg-surface-1" />;
}

export function PreviewPanel({
  url,
  supportsWebview,
  onUrlChange,
  onClose,
}: {
  url: string;
  /** False in shells without <webview> (future WebUI); only external open works. */
  supportsWebview: boolean;
  onUrlChange: (url: string) => void;
  onClose: () => void;
}) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const normalized = normalizeLocalUrl(url);
  const invalid = url.trim().length > 0 && !normalized;

  return (
    <aside className="flex w-2/5 min-w-[340px] max-w-[480px] shrink-0 flex-col border-0 border-l border-line-1 bg-surface-2">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-0 border-b border-line-1 px-3">
        <IconPublic className="shrink-0 text-fg-3" />
        <Input
          size="small"
          value={url}
          placeholder="localhost:5173"
          aria-label="预览地址"
          error={invalid}
          onChange={onUrlChange}
        />
        <Tooltip content="刷新" mini>
          <Button
            size="small"
            type="text"
            icon={<IconRefresh />}
            aria-label="刷新预览"
            disabled={!normalized || !supportsWebview}
            onClick={() => webviewRef.current?.reload?.()}
          />
        </Tooltip>
        <Tooltip content="在浏览器中打开" mini>
          <Button
            size="small"
            type="text"
            icon={<IconLaunch />}
            aria-label="在浏览器中打开"
            disabled={!normalized}
            onClick={() => {
              if (normalized) window.open(normalized, '_blank');
            }}
          />
        </Tooltip>
        <Tooltip content="关闭预览" mini>
          <Button
            size="small"
            type="text"
            icon={<IconClose />}
            aria-label="关闭预览"
            onClick={onClose}
          />
        </Tooltip>
      </header>
      {normalized && supportsWebview ? (
        <WebviewSurface src={normalized} elementRef={webviewRef} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-1 px-6 text-center text-xs leading-5 text-fg-3">
          {!supportsWebview && normalized
            ? '当前环境不支持内嵌预览，请使用「在浏览器中打开」'
            : invalid
              ? '仅支持本机地址（localhost / 127.0.0.1）'
              : '输入 dev server 地址，如 localhost:5173；agent 消息里的本机链接也可以直接点'}
        </div>
      )}
    </aside>
  );
}
