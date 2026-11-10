import { Button, Message } from '@arco-design/web-react';
import type { Conversation, PermissionOption } from '@nexus/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NexusAppIcon } from '../brand/NexusMark';
import { CollaborationPreview } from '../conversation/CollaborationDialogs';
import { Composer } from '../conversation/Composer';
import { ConversationHeader } from '../conversation/ConversationHeader';
import {
  type NewConversationInput,
  NewConversationModal,
} from '../conversation/NewConversationModal';
import { Timeline } from '../conversation/Timeline';
import { buildTimeline } from '../model/buildTimeline';
import type { CoreSnapshot, CoreStore } from '../model/coreStore';
import { useUiState } from '../model/useUiState';
import type { ThemePreference } from '../theme/themePreference';
import { DetailPanel } from './DetailPanel';
import { Sidebar } from './Sidebar';
import { TabStrip } from './TabStrip';

type WorkspaceProps = {
  store: CoreStore;
  snapshot: CoreSnapshot;
  pickDirectory: (() => Promise<string | null>) | null;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
};

const reportError = (error: unknown) =>
  Message.error(error instanceof Error ? error.message : String(error));

/**
 * Tabs, drafts and read positions are local view state (persisted per
 * window); everything about conversations comes from core. Closing a tab
 * only closes the view — the run keeps going.
 */
export function Workspace({
  store,
  snapshot,
  pickDirectory,
  theme,
  onThemeChange,
}: WorkspaceProps) {
  const [ui, setUi] = useUiState();
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<'delegate' | 'handoff' | null>(null);
  const closedStack = useRef<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const { conversations } = snapshot;
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
  const ready = snapshot.status === 'ready';
  const tabs = ui.openIds.flatMap((id) => byId.get(id) ?? []);
  const activeId = ui.activeId && byId.has(ui.activeId) ? ui.activeId : (tabs[0]?.id ?? null);
  const active = activeId ? byId.get(activeId) : undefined;
  const events = activeId ? snapshot.events.get(activeId) : undefined;
  const timeline = useMemo(() => (events ? buildTimeline(events) : null), [events]);

  // Forget tabs whose conversation no longer exists (only once the list is loaded).
  useEffect(() => {
    if (!ready) return;
    setUi((s) => {
      const openIds = s.openIds.filter((id) => byId.has(id));
      return openIds.length === s.openIds.length ? s : { ...s, openIds };
    });
  }, [ready, byId, setUi]);

  // Load the active conversation's history, and keep marking it as read.
  useEffect(() => {
    if (ready && activeId) store.loadEvents(activeId).catch(reportError);
  }, [ready, activeId, store]);
  const activeLastSeq = active?.lastSeq;
  useEffect(() => {
    if (!activeId || activeLastSeq === undefined) return;
    setUi((s) =>
      s.seen[activeId] === activeLastSeq
        ? s
        : { ...s, seen: { ...s.seen, [activeId]: activeLastSeq } },
    );
  }, [activeId, activeLastSeq, setUi]);

  const unread = useCallback(
    (c: Conversation) =>
      c.id !== activeId && ui.seen[c.id] !== undefined && c.lastSeq > (ui.seen[c.id] ?? 0),
    [activeId, ui.seen],
  );

  const open = useCallback(
    (id: string) => {
      setUi((s) => ({
        ...s,
        activeId: id,
        openIds: s.openIds.includes(id) ? s.openIds : [...s.openIds, id],
      }));
    },
    [setUi],
  );

  const close = useCallback(
    (id: string) => {
      setUi((s) => {
        const index = s.openIds.indexOf(id);
        const openIds = s.openIds.filter((x) => x !== id);
        const nextActive =
          s.activeId === id ? (openIds[Math.min(index, openIds.length - 1)] ?? null) : s.activeId;
        return { ...s, openIds, activeId: nextActive };
      });
      closedStack.current.push(id);
    },
    [setUi],
  );

  const reopen = useCallback(() => {
    while (closedStack.current.length) {
      const id = closedStack.current.pop();
      if (id && byId.has(id)) {
        open(id);
        return;
      }
    }
  }, [byId, open]);

  const create = async (input: NewConversationInput) => {
    const conversation = await store.createConversation(input);
    setUi((s) => ({ ...s, seen: { ...s.seen, [conversation.id]: 0 } }));
    open(conversation.id);
    setCreating(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (key === 't' && event.shiftKey) {
        event.preventDefault();
        reopen();
      } else if (key === 't') {
        event.preventDefault();
        setCreating(true);
      } else if (key === 'w' && activeId) {
        event.preventDefault();
        close(activeId);
      } else if (/^[1-9]$/.test(key)) {
        const target = ui.openIds[Number(key) - 1];
        if (target) {
          event.preventDefault();
          open(target);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeId, ui.openIds, close, open, reopen]);

  const send = () => {
    if (!active) return;
    const text = (ui.drafts[active.id] ?? '').trim();
    if (!text) return;
    const id = active.id;
    setUi((s) => ({ ...s, drafts: { ...s.drafts, [id]: '' } }));
    store.send(id, text).catch((error) => {
      // Give the text back so nothing typed is lost.
      setUi((s) => ({ ...s, drafts: { ...s.drafts, [id]: s.drafts[id] || text } }));
      reportError(error);
    });
  };

  const lastUserText = events?.findLast((e) => e.body.type === 'user.message')?.body;
  const retry =
    active && lastUserText?.type === 'user.message' && active.state === 'failed'
      ? () => void store.send(active.id, lastUserText.text).catch(reportError)
      : null;

  const respond = (requestId: string, option: PermissionOption) => {
    if (active) store.respondToPermission(active.id, requestId, option.id).catch(reportError);
  };

  const harness = active ? snapshot.harnesses?.find((h) => h.id === active.harnessId) : undefined;
  const defaultCwd = active?.cwd ?? conversations[0]?.cwd ?? null;

  return (
    <div className="flex h-full">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        unread={unread}
        onOpen={open}
        onNew={() => setCreating(true)}
        harnesses={snapshot.harnesses}
        theme={theme}
        onThemeChange={onThemeChange}
        searchRef={searchRef}
      />
      <div className="flex min-w-0 flex-1 flex-col bg-surface-1">
        <TabStrip
          tabs={tabs}
          unread={unread}
          activeId={activeId}
          onActivate={open}
          onClose={close}
          onNew={() => setCreating(true)}
        />
        {active ? (
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <ConversationHeader
                conversation={active}
                detailOpen={ui.detailOpen}
                onToggleDetail={() => setUi((s) => ({ ...s, detailOpen: !s.detailOpen }))}
                onStop={() => store.cancel(active.id).catch(reportError)}
              />
              <Timeline
                conversationId={active.id}
                agent={active.harnessId}
                items={timeline?.items ?? null}
                revision={events?.length ?? 0}
                onPermission={respond}
                onRetry={retry}
              />
              <Composer
                conversation={active}
                draft={ui.drafts[active.id] ?? ''}
                onDraftChange={(value) =>
                  setUi((s) => ({ ...s, drafts: { ...s.drafts, [active.id]: value } }))
                }
                onSend={send}
                onStop={() => store.cancel(active.id).catch(reportError)}
                onPreviewCollaboration={setPreview}
              />
            </main>
            {ui.detailOpen && (
              <DetailPanel conversation={active} harness={harness} runs={timeline?.runs ?? []} />
            )}
          </div>
        ) : (
          <Welcome
            status={snapshot.status}
            error={snapshot.error}
            onNew={() => setCreating(true)}
            canReopen={closedStack.current.length > 0}
            onReopen={reopen}
          />
        )}
      </div>
      {active && (
        <CollaborationPreview
          kind={preview}
          conversation={active}
          onClose={() => setPreview(null)}
        />
      )}
      <NewConversationModal
        visible={creating}
        harnesses={snapshot.harnesses}
        defaultCwd={defaultCwd}
        pickDirectory={pickDirectory}
        onCancel={() => setCreating(false)}
        onCreate={create}
      />
    </div>
  );
}

function Welcome({
  status,
  error,
  onNew,
  canReopen,
  onReopen,
}: {
  status: CoreSnapshot['status'];
  error: string | null;
  onNew: () => void;
  canReopen: boolean;
  onReopen: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <NexusAppIcon size={72} />
      <div className="text-center">
        <div className="text-[17px] font-semibold text-fg-1">Nexus</div>
        <div className="mt-1 text-xs text-fg-3">A workspace for connected agents.</div>
      </div>
      {status === 'failed' ? (
        <div className="max-w-[420px] text-center text-xs text-bad">核心服务连接失败：{error}</div>
      ) : (
        <div className="flex gap-2">
          <Button type="primary" disabled={status !== 'ready'} onClick={onNew}>
            新会话 ⌘T
          </Button>
          <Button disabled={!canReopen} onClick={onReopen}>
            重新打开 ⌘⇧T
          </Button>
        </div>
      )}
    </div>
  );
}
