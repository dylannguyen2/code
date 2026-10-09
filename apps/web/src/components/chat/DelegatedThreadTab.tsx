import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { delegatedThreadIsActive } from "@t3tools/client-runtime/state/delegated-threads";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  FileDiffIcon,
  GlobeIcon,
  MessageSquareIcon,
  SquareIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import {
  type DelegatedThreadView,
  type RightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  useProject,
  useThreadProjection,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { terminalEnvironment } from "../../state/terminal";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import { deriveWorkspaceMutationId } from "../ChatView.logic";
import { PersistentThreadTerminalPanel } from "../PersistentThreadTerminalPanel";
import { addBrowserSurface } from "../preview/addBrowserSurface";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DelegatedThreadChat } from "./DelegatedThreadChat";
import { DelegatedThreadMeta, useDelegatedThreadRow } from "./DelegatedThreadsPanel";
import { DelegatedThreadStateIcon } from "./DelegatedThreadStateIcon";

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("../DiffPanel"));

const VIEWS: ReadonlyArray<{
  readonly view: DelegatedThreadView;
  readonly label: string;
  readonly icon: typeof MessageSquareIcon;
}> = [
  { view: "chat", label: "Chat", icon: MessageSquareIcon },
  { view: "changes", label: "Changes", icon: FileDiffIcon },
  { view: "terminal", label: "Terminal", icon: TerminalSquareIcon },
  { view: "browser", label: "Browser", icon: GlobeIcon },
];

/**
 * One delegated thread in its own right-panel tab: its chat, or one of the
 * tools of its own workspace. Terminal and browser tabs are the thread's own,
 * so they are still there when the full thread is opened.
 */
export function DelegatedThreadTab(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly view: DelegatedThreadView;
  readonly visible: boolean;
}) {
  const { parentRef, threadId, view } = props;
  const childRef = useMemo(
    () => scopeThreadRef(parentRef.environmentId, threadId),
    [parentRef.environmentId, threadId],
  );
  const row = useDelegatedThreadRow(parentRef, threadId);
  const shell = useThreadShell(childRef);
  const navigate = useNavigate();
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [stopping, setStopping] = useState(false);
  const active = row !== null && delegatedThreadIsActive(row.state);
  const title = shell?.title ?? row?.title ?? "Thread";

  const setView = (next: DelegatedThreadView) =>
    useRightPanelStore.getState().openDelegatedThread(parentRef, threadId, next);
  const openFullThread = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(childRef) });
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    const result = await interruptTurn({
      environmentId: childRef.environmentId,
      input: { threadId: childRef.threadId },
    });
    setStopping(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({ type: "error", title: "Could not stop this thread" });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-delegated-thread-tab={view}>
      <div className="flex flex-col gap-1.5 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {row === null ? null : <DelegatedThreadStateIcon state={row.state} className="size-4" />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {active ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void stop()}
                    disabled={stopping}
                    aria-label="Stop this thread"
                  />
                }
              >
                <SquareIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Stop</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={openFullThread}
                  aria-label="Open the full thread"
                />
              }
            >
              <ArrowUpRightIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open the full thread</TooltipPopup>
          </Tooltip>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0">{row === null ? null : <DelegatedThreadMeta row={row} />}</span>
          <ToggleGroup
            aria-label="Thread view"
            value={[view]}
            onValueChange={(next) => {
              const value = VIEWS.find((entry) => entry.view === next[0]);
              if (value) setView(value.view);
            }}
          >
            {VIEWS.map((entry) => (
              <Tooltip key={entry.view}>
                <TooltipTrigger
                  render={
                    <Toggle
                      value={entry.view}
                      aria-label={entry.label}
                      data-delegated-thread-view={entry.view}
                    />
                  }
                >
                  <entry.icon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">{entry.label}</TooltipPopup>
              </Tooltip>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === "chat" ? (
          <DelegatedThreadChat parentRef={parentRef} childRef={childRef} />
        ) : view === "changes" ? (
          <DelegatedThreadChanges childRef={childRef} />
        ) : view === "terminal" ? (
          <DelegatedThreadTerminal childRef={childRef} visible={props.visible} />
        ) : (
          <DelegatedThreadBrowser childRef={childRef} visible={props.visible} />
        )}
      </div>
    </div>
  );
}

function DelegatedThreadChanges(props: { readonly childRef: ScopedThreadRef }) {
  const projection = useThreadProjection(props.childRef)?.projection ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(props.childRef);
  const { turnDiffSummaries } = useTurnDiffSummaries(projection);
  const workspaceMutationId = useMemo(
    () => deriveWorkspaceMutationId(visibleTurnItems, turnDiffSummaries),
    [turnDiffSummaries, visibleTurnItems],
  );
  return (
    <Suspense fallback={null}>
      <DiffPanel
        mode="embedded"
        threadRef={props.childRef}
        composerDraftTarget={props.childRef}
        workspaceMutationId={workspaceMutationId}
      />
    </Suspense>
  );
}

/** The thread's own panel terminal, opened in its worktree the first time it is shown. */
function DelegatedThreadTerminal(props: {
  readonly childRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const { childRef } = props;
  const environmentId = childRef.environmentId;
  const shell = useThreadShell(childRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const knownSessions = useKnownTerminalSessions({
    environmentId,
    threadId: childRef.threadId,
  });
  const surface = useRightPanelStore(
    (state) =>
      selectThreadRightPanelState(state.byThreadKey, childRef).surfaces.find(
        (entry): entry is Extract<RightPanelSurface, { kind: "terminal" }> =>
          entry.kind === "terminal",
      ) ?? null,
  );
  const [focusRequestId, setFocusRequestId] = useState(0);
  const worktreePath = shell?.worktreePath ?? null;

  const startTerminal = useCallback(
    (place: (terminalId: string) => void) => {
      if (!project || !readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
      const knownIds = (knownSessions ?? []).map((session) => session.target.terminalId);
      const terminalId = nextTerminalId(
        [...new Set([...knownIds, ...(surface?.terminalIds ?? [])])],
        knownSessions !== null && readEnvironmentScope(environmentId, AuthTerminalReadScope)
          ? undefined
          : randomUUID(),
      );
      place(terminalId);
      setFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: childRef.threadId,
          terminalId,
          cwd: projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }),
          ...(worktreePath !== null ? { worktreePath } : {}),
          env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
        },
      });
    },
    [childRef.threadId, environmentId, knownSessions, openTerminal, project, surface, worktreePath],
  );
  const addTerminal = useCallback(
    () =>
      startTerminal((terminalId) =>
        useRightPanelStore.getState().openTerminal(childRef, terminalId),
      ),
    [childRef, startTerminal],
  );
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical") => {
      if (surface === null || surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return;
      startTerminal((terminalId) =>
        useRightPanelStore.getState().splitTerminal(childRef, surface.id, terminalId, direction),
      );
    },
    [childRef, startTerminal, surface],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (surface === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope))
        return;
      void closeTerminalMutation({
        environmentId,
        input: { threadId: childRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(childRef, terminalId);
      useRightPanelStore.getState().closeTerminal(childRef, surface.id, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [childRef, closeTerminalMutation, environmentId, storeCloseTerminal, surface],
  );

  // Showing the view is the request for a terminal.
  const requestedRef = useRef(false);
  useEffect(() => {
    if (surface !== null || requestedRef.current || !project || !canOperateTerminal) return;
    if (knownSessions === null) return;
    requestedRef.current = true;
    addTerminal();
  }, [addTerminal, canOperateTerminal, knownSessions, project, surface]);

  if (!canOperateTerminal) {
    return <ThreadToolNotice>This connection cannot open terminals.</ThreadToolNotice>;
  }
  if (surface === null) return null;
  return (
    <PersistentThreadTerminalPanel
      visible={props.visible}
      threadRef={childRef}
      surface={surface}
      launchContext={null}
      focusRequestId={focusRequestId}
      keybindings={keybindings}
      onAddTerminalContext={() => undefined}
      onSplitTerminal={() => splitTerminal("horizontal")}
      onSplitTerminalVertical={() => splitTerminal("vertical")}
      onNewTerminal={addTerminal}
      onActiveTerminalChange={(terminalId) => {
        useRightPanelStore.getState().activateTerminal(childRef, surface.id, terminalId);
        setFocusRequestId((value) => value + 1);
      }}
      onCloseTerminal={closeTerminal}
    />
  );
}

/** The thread's own browser tab, opened the first time the view is shown. */
function DelegatedThreadBrowser(props: {
  readonly childRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const { childRef } = props;
  const canOperatePreview = useEnvironmentScope(childRef.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const tabId = useRightPanelStore(
    (state) =>
      selectThreadRightPanelState(state.byThreadKey, childRef).surfaces.find(
        (entry): entry is Extract<RightPanelSurface, { kind: "preview" }> =>
          entry.kind === "preview" && entry.resourceId !== null,
      )?.resourceId ?? null,
  );
  const requestedRef = useRef(false);
  useEffect(() => {
    if (tabId !== null || requestedRef.current || !canOperatePreview) return;
    requestedRef.current = true;
    void addBrowserSurface({ threadRef: childRef, openPreview }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: "Could not open a browser for this thread" });
      }
    });
  }, [canOperatePreview, childRef, openPreview, tabId]);

  if (!canOperatePreview) {
    return <ThreadToolNotice>This connection cannot open browser tabs.</ThreadToolNotice>;
  }
  if (tabId === null) return null;
  return (
    <Suspense fallback={null}>
      <PreviewPanel mode="embedded" threadRef={childRef} tabId={tabId} visible={props.visible} />
    </Suspense>
  );
}

function ThreadToolNotice(props: { readonly children: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {props.children}
    </div>
  );
}
