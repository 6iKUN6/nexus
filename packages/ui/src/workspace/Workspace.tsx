import { Button, Message } from '@arco-design/web-react';
import type { Conversation, Handoff, MessageRecord, PermissionOption, Task } from '@nexus/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NexusAppIcon } from '../brand/NexusMark';
import { Composer } from '../conversation/Composer';
import { ConversationHeader } from '../conversation/ConversationHeader';
import { DelegateDialog, type DelegateInput } from '../conversation/DelegateDialog';
import {
  HandoffDialog,
  type HandoffDraft,
  type HandoffSuggestion,
} from '../conversation/HandoffDialog';
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
import { PreviewPanel } from './PreviewPanel';
import { Sidebar } from './Sidebar';
import { TabStrip } from './TabStrip';

type WorkspaceProps = {
  store: CoreStore;
  snapshot: CoreSnapshot;
  pickDirectory: (() => Promise<string | null>) | null;
  revealPath: ((path: string) => void) | null;
  /** Electron shell: the preview pane can embed a real webview (ADR 0014). */
  webPreview: boolean;
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
  revealPath,
  webPreview,
  theme,
  onThemeChange,
}: WorkspaceProps) {
  const [ui, setUi] = useUiState();
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [collaboration, setCollaboration] = useState<'delegate' | 'handoff' | null>(null);
  const [handoffSuggestion, setHandoffSuggestion] = useState<HandoffSuggestion | null>(null);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const [agentMessages, setAgentMessages] = useState<MessageRecord[]>([]);
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
  // Delivery states live in the messages table, not the log; every state
  // change coincides with an event, so the event count is the refresh signal.
  const eventsRevision = events?.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: eventsRevision refreshes states on every new event
  useEffect(() => {
    if (!ready || !activeId) {
      setAgentMessages([]);
      return;
    }
    let cancelled = false;
    store.listMessages(activeId).then(
      ({ messages }) => {
        if (!cancelled) setAgentMessages(messages);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [ready, activeId, store, eventsRevision]);
  const messageStates = useMemo(
    () => Object.fromEntries(agentMessages.map((message) => [message.id, message])),
    [agentMessages],
  );

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

  // A child conversation shows a banner linking back to its delegating parent.
  useEffect(() => {
    if (!ready || !activeId) {
      setParentTask(null);
      return;
    }
    let cancelled = false;
    store
      .listTasks(activeId)
      .then(({ parent }) => {
        if (!cancelled) setParentTask(parent);
      })
      .catch(() => {
        if (!cancelled) setParentTask(null);
      });
    return () => {
      cancelled = true;
    };
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

  const respondToTask = (taskId: string, action: 'accept' | 'request_changes', feedback?: string) =>
    store.respondToTask(taskId, action, feedback).catch(reportError);

  const delegate = async (input: DelegateInput) => {
    if (!active) return;
    await store.delegate({ conversationId: active.id, ...input });
    // Stay in the parent; the delegation card shows live progress.
    setCollaboration(null);
    Message.success('子任务已创建，正在独立 worktree 中执行');
  };

  const prepareHandoff = async (draft: HandoffDraft): Promise<Handoff> => {
    if (!active) throw new Error('没有打开的会话');
    return store.prepareHandoff({ conversationId: active.id, ...draft });
  };
  const commitHandoff = async (handoff: Handoff): Promise<void> => {
    await store.commitHandoff(handoff.id, handoff.version);
    setCollaboration(null);
    Message.success('交接完成，任务已交给新 Agent');
  };
  const cancelHandoff = async (handoff: Handoff): Promise<void> => {
    await store.cancelHandoff(handoff.id);
  };

  const harness = active ? snapshot.harnesses?.find((h) => h.id === active.harnessId) : undefined;
  const defaultCwd = active?.cwd ?? conversations[0]?.cwd ?? null;

  const exportDiagnostics = async () => {
    setExporting(true);
    try {
      const result = await store.exportDiagnostics();
      revealPath?.(result.path);
      Message.success(
        `诊断包已导出（已脱敏 ${result.redactions.events + result.redactions.envKeys} 处）`,
      );
    } catch (error) {
      reportError(error);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        unread={unread}
        onOpen={open}
        onNew={() => setCreating(true)}
        harnesses={snapshot.harnesses}
        taskInbox={snapshot.taskInbox}
        theme={theme}
        onThemeChange={onThemeChange}
        searchRef={searchRef}
        exporting={exporting}
        onExportDiagnostics={() => void exportDiagnostics()}
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
                previewOpen={ui.previewOpen}
                onTogglePreview={() => setUi((s) => ({ ...s, previewOpen: !s.previewOpen }))}
                onStop={() => store.cancel(active.id).catch(reportError)}
              />
              {parentTask && (
                <button
                  type="button"
                  className="shrink-0 cursor-pointer border-0 border-b border-line-1 bg-tint-1 px-5 py-1.5 text-left text-xs text-fg-2 hover:bg-tint-2"
                  onClick={() => open(parentTask.parentConversationId)}
                >
                  这是「{byId.get(parentTask.parentConversationId)?.title ?? '另一个会话'}
                  」委派的子任务 · 点击查看委派会话 →
                </button>
              )}
              <Timeline
                conversationId={active.id}
                agent={active.harnessId}
                items={timeline?.items ?? null}
                revision={events?.length ?? 0}
                onPermission={respond}
                onRetry={retry}
                onOpenConversation={open}
                onTaskRespond={respondToTask}
                messageStates={messageStates}
                onResendMessage={(messageId) => {
                  if (!active) return;
                  void store
                    .resendMessage(messageId)
                    .then(() => store.listMessages(active.id))
                    .then(({ messages }) => setAgentMessages(messages))
                    .catch(reportError);
                }}
                onRequestHandoff={(toHarnessId) => {
                  // The agent asked first; suggestHandoff still fills goal and
                  // next action, but the agent's target wins over the derived one.
                  store
                    .suggestHandoff(active.id)
                    .then((s) => setHandoffSuggestion({ ...s, toHarnessId }))
                    .catch(() => setHandoffSuggestion({ goal: '', nextAction: '', toHarnessId }))
                    .finally(() => setCollaboration('handoff'));
                }}
                onOpenLocalUrl={(url) =>
                  setUi((s) => ({
                    ...s,
                    previewOpen: true,
                    previewUrls: { ...s.previewUrls, [active.id]: url },
                  }))
                }
              />
              <Composer
                conversation={active}
                draft={ui.drafts[active.id] ?? ''}
                onDraftChange={(value) =>
                  setUi((s) => ({ ...s, drafts: { ...s.drafts, [active.id]: value } }))
                }
                onSend={send}
                onStop={() => store.cancel(active.id).catch(reportError)}
                onCollaboration={(mode) => {
                  if (mode !== 'handoff') {
                    setCollaboration(mode);
                    return;
                  }
                  // Prefill from core before opening (D22); a failed read just
                  // means an empty form, never a blocked handoff.
                  store
                    .suggestHandoff(active.id)
                    .then(setHandoffSuggestion, () => setHandoffSuggestion(null))
                    .finally(() => setCollaboration('handoff'));
                }}
              />
            </main>
            {ui.detailOpen && (
              <DetailPanel
                conversation={active}
                harness={harness}
                runs={timeline?.runs ?? []}
                harnesses={snapshot.harnesses}
                onConfigure={(patch) => {
                  void store
                    .configureConversation({ conversationId: active.id, ...patch })
                    .catch(reportError);
                }}
              />
            )}
            {ui.previewOpen && (
              <PreviewPanel
                url={ui.previewUrls[active.id] ?? ''}
                supportsWebview={webPreview}
                onUrlChange={(url) =>
                  setUi((s) => ({
                    ...s,
                    previewUrls: { ...s.previewUrls, [active.id]: url },
                  }))
                }
                onClose={() => setUi((s) => ({ ...s, previewOpen: false }))}
              />
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
      {active && collaboration === 'delegate' && (
        <DelegateDialog
          visible
          conversation={active}
          harnesses={snapshot.harnesses}
          onCancel={() => setCollaboration(null)}
          onDelegate={delegate}
        />
      )}
      {active && collaboration === 'handoff' && (
        <HandoffDialog
          visible
          conversation={active}
          harnesses={snapshot.harnesses}
          suggestion={handoffSuggestion}
          onClose={() => setCollaboration(null)}
          onPrepare={prepareHandoff}
          onCommit={commitHandoff}
          onCancelHandoff={cancelHandoff}
        />
      )}
      <NewConversationModal
        visible={creating}
        harnesses={snapshot.harnesses}
        defaultCwd={defaultCwd}
        pickDirectory={pickDirectory}
        inspectPath={(cwd) => store.inspectPath(cwd)}
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
