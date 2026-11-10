import { Button, Tooltip } from '@arco-design/web-react';
import { IconClose, IconPlus } from '@arco-design/web-react/icon';
import type { Conversation } from '@nexus/protocol';
import { useRef } from 'react';
import { StatusIcon } from './StatusLabel';

type TabStripProps = {
  tabs: Conversation[];
  unread: (conversation: Conversation) => boolean;
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
};

/**
 * Browser-style tabs (Safari look). Arco's Tabs cannot be shaped like this,
 * so this is a custom tablist with full ARIA and arrow-key navigation.
 * Running state and unread count are separate indicators.
 */
export function TabStrip({ tabs, unread, activeId, onActivate, onClose, onNew }: TabStripProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onActivate(tab.id);
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"]`)?.focus();
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line-2 bg-titlebar px-2 [-webkit-app-region:drag]">
      <div
        ref={listRef}
        role="tablist"
        aria-label="打开的会话"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.title}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') focusTab(index + 1);
                if (event.key === 'ArrowLeft') focusTab(index - 1);
              }}
              className={`group flex h-7 max-w-[220px] min-w-[120px] flex-1 items-center gap-1.5 rounded-md pr-1 pl-2.5 outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-brand ${
                active ? 'bg-elevated shadow-mac' : 'hover:bg-tint-2'
              }`}
            >
              <span className="flex size-3 shrink-0 items-center justify-center text-[11px]">
                <StatusIcon state={tab.state} />
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-xs ${active ? 'font-medium text-fg-1' : 'text-fg-2'}`}
              >
                {tab.title}
              </span>
              {unread(tab) && !active && (
                <span className="size-2 shrink-0 rounded-full bg-brand">
                  <span className="sr-only">有未读</span>
                </span>
              )}
              <Button
                size="mini"
                type="text"
                aria-label={`关闭 ${tab.title}`}
                icon={<IconClose />}
                tabIndex={-1}
                className={`shrink-0 text-fg-3 ${active ? '' : 'opacity-0 group-hover:opacity-100'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              />
            </div>
          );
        })}
      </div>
      <Tooltip content="新会话 ⌘T" mini>
        <Button
          size="small"
          type="text"
          icon={<IconPlus />}
          aria-label="新会话"
          className="shrink-0 text-fg-2 [-webkit-app-region:no-drag]"
          onClick={onNew}
        />
      </Tooltip>
    </div>
  );
}
