import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  delegatedThreadIsActive,
  deriveDelegatedThreadRows,
  summarizeDelegatedThreads,
  type DelegatedThreadRow,
  type DelegatedThreadState,
} from "@t3tools/client-runtime/state/delegated-threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveLatestThreadRun,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type {
  OrchestrationV2ThreadShell,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  GitBranchIcon,
  HandIcon,
  ListChecksIcon,
  SendHorizontalIcon,
  SquareIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn, newMessageId, newThreadId } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  deriveActiveWorkStartedAt,
  derivePhase,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  isLatestRunSettled,
  type TimelineEntriesProjection,
} from "../../session-logic";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShells,
  useThreadVisibleTurnItems,
  waitForThreadShell,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { MessagesTimeline } from "./MessagesTimeline";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";

const STATE_PRESENTATION: Record<
  DelegatedThreadState,
  { readonly icon: LucideIcon; readonly label: string; readonly className: string }
> = {
  preparing: {
    icon: CircleDashedIcon,
    label: "Setting up",
    className: "text-muted-foreground",
  },
  running: { icon: CircleDotIcon, label: "Working", className: "text-info" },
  waiting: { icon: HandIcon, label: "Needs input", className: "text-warning" },
  done: { icon: CircleCheckIcon, label: "Done", className: "text-success" },
  failed: { icon: CircleXIcon, label: "Failed", className: "text-destructive" },
  stopped: { icon: CircleSlashIcon, label: "Stopped", className: "text-muted-foreground" },
};

const EMPTY_TURN_DIFFS: never[] = [];
const noop = () => undefined;

/** The delegated threads of `threadRef`, one checklist row per child thread. */
export function useDelegatedThreadRows(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<DelegatedThreadRow> {
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const subagents = projection?.subagents;
  const hasDelegatedThreads =
    subagents?.some((task) => task.origin === "app_owned" && task.childThreadId !== null) ?? false;
  // Shell updates arrive for every thread, so only subscribe once there is a child to show.
  const shells = useThreadShells(hasDelegatedThreads);
  return useMemo(() => {
    if (threadRef === null || subagents === undefined || !hasDelegatedThreads) return [];
    const shellsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
    for (const shell of shells) {
      if (shell.environmentId === threadRef.environmentId) shellsById.set(shell.id, shell.source);
    }
    return deriveDelegatedThreadRows({ subagents, shellsById });
  }, [hasDelegatedThreads, shells, subagents, threadRef]);
}

export function DelegatedThreadsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly selectedThreadId: string | null;
  readonly orchestrator: boolean;
}) {
  const rows = useDelegatedThreadRows(props.threadRef);
  const select = useCallback(
    (threadId: ThreadId | null) =>
      useRightPanelStore.getState().selectDelegatedThread(props.threadRef, threadId),
    [props.threadRef],
  );
  const selected = rows.find((row) => row.threadId === props.selectedThreadId) ?? null;
  if (selected !== null) {
    return (
      <DelegatedThreadDetail
        key={selected.threadId}
        parentRef={props.threadRef}
        row={selected}
        onBack={() => select(null)}
      />
    );
  }
  return <DelegatedThreadList rows={rows} orchestrator={props.orchestrator} onSelect={select} />;
}

function DelegatedThreadList(props: {
  readonly rows: ReadonlyArray<DelegatedThreadRow>;
  readonly orchestrator: boolean;
  readonly onSelect: (threadId: ThreadId) => void;
}) {
  if (props.rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <ListChecksIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No delegated threads yet</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          {props.orchestrator
            ? "Ask for work in the chat. The orchestrator splits it into threads, each on its own branch in its own worktree, and they show up here."
            : "Threads this agent delegates show up here."}
        </p>
      </div>
    );
  }
  const progress = summarizeDelegatedThreads(props.rows);
  return (
    <div className="flex h-full min-h-0 flex-col" data-delegated-threads-list>
      <div className="flex flex-col gap-1.5 border-b px-3 py-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-foreground">Delegated threads</span>
          <span className="text-muted-foreground tabular-nums">
            {progress.done} of {progress.total} done
            {progress.active > 0 ? ` · ${progress.active} working` : ""}
          </span>
        </div>
        <div
          aria-hidden
          className="h-1 overflow-hidden rounded-full bg-muted"
          data-delegated-threads-progress
        >
          <div
            className="h-full rounded-full bg-success"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul aria-label="Delegated threads" className="m-0 flex list-none flex-col p-1.5">
          {props.rows.map((row) => (
            <li key={row.threadId}>
              <DelegatedThreadListRow row={row} onSelect={props.onSelect} />
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

function DelegatedThreadListRow(props: {
  readonly row: DelegatedThreadRow;
  readonly onSelect: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const presentation = STATE_PRESENTATION[row.state];
  const StateIcon = presentation.icon;
  const settled = !delegatedThreadIsActive(row.state);
  return (
    <button
      type="button"
      onClick={() => props.onSelect(row.threadId)}
      data-delegated-thread-row={row.state}
      className="group flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <StateIcon
        aria-label={presentation.label}
        className={cn("mt-0.5 size-4 shrink-0", presentation.className)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-sm",
            row.state === "done" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {row.title}
        </span>
        <DelegatedThreadMeta row={row} />
      </span>
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground/60 group-hover:text-foreground",
          settled && "opacity-60",
        )}
      />
    </button>
  );
}

function DelegatedThreadMeta(props: { readonly row: DelegatedThreadRow }) {
  const { row } = props;
  const presentation = STATE_PRESENTATION[row.state];
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {row.branch === null ? null : (
        <>
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-mono text-2xs">{row.branch}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span className={cn("shrink-0", presentation.className)}>{presentation.label}</span>
      {row.activeSince === null ? null : (
        <span className="shrink-0 tabular-nums">
          <AgentElapsed
            agent={{ status: "running", startedAt: row.activeSince, completedAt: null }}
            compact
          />
        </span>
      )}
    </span>
  );
}

function DelegatedThreadDetail(props: {
  readonly parentRef: ScopedThreadRef;
  readonly row: DelegatedThreadRow;
  readonly onBack: () => void;
}) {
  const { row } = props;
  const childRef = useMemo(
    () => scopeThreadRef(props.parentRef.environmentId, row.threadId),
    [props.parentRef.environmentId, row.threadId],
  );
  const navigate = useNavigate();
  const projection = useThreadProjection(childRef)?.projection ?? null;
  const active = delegatedThreadIsActive(row.state);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [stopping, setStopping] = useState(false);
  // An agent that cannot take a steer mid-turn queues it for the next turn.
  const queuedMessages = useMemo(
    () =>
      projection === null
        ? []
        : projection.runs.flatMap((run) => {
            if (run.status !== "queued") return [];
            const message = projection.messages.find(
              (candidate) => candidate.id === run.userMessageId,
            );
            return message === undefined ? [] : [{ runId: run.id, text: message.text }];
          }),
    [projection],
  );

  const openFullThread = useCallback(() => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(childRef) });
  }, [childRef, navigate]);

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
    <div className="flex h-full min-h-0 flex-col" data-delegated-thread-detail>
      <div className="flex flex-col gap-1 border-b px-2 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" size="xs" onClick={props.onBack} aria-label="Back to threads">
            <ChevronLeftIcon />
            Threads
          </Button>
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{row.title}</span>
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
        <span className="px-2">
          <DelegatedThreadMeta row={row} />
        </span>
      </div>
      <DelegatedThreadTimeline childRef={childRef} onOpenFullThread={openFullThread} />
      {queuedMessages.length === 0 ? null : (
        <ul
          aria-label="Queued messages"
          className="m-0 flex list-none flex-col gap-1 border-t px-3 py-2"
          data-delegated-thread-queued
        >
          {queuedMessages.map((queued) => (
            <li
              key={queued.runId}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            >
              <ClockIcon aria-hidden className="size-3 shrink-0" />
              <span className="shrink-0">Queued for the next turn</span>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate text-foreground">{queued.text}</span>
            </li>
          ))}
        </ul>
      )}
      {projection === null ? null : (
        <DelegatedThreadSteer
          childRef={childRef}
          active={active}
          runtimeMode={projection.thread.runtimeMode}
          interactionMode={projection.thread.interactionMode}
        />
      )}
    </div>
  );
}

function DelegatedThreadTimeline(props: {
  readonly childRef: ScopedThreadRef;
  readonly onOpenFullThread: () => void;
}) {
  const { childRef } = props;
  const childKey = scopedThreadKey(childRef);
  const projection = useThreadProjection(childRef)?.projection ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(childRef);
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const timestampFormat = useEnvironmentSettings(childRef.environmentId).timestampFormat;
  const providers = useServerConfigs().get(childRef.environmentId)?.providers ?? [];
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === childRef.environmentId &&
      candidate.id === projection?.thread.projectId,
  );
  const listRef = useRef<LegendListRef | null>(null);
  const timelineProjectionRef = useRef<TimelineEntriesProjection | null>(null);
  const timelineEntries = useMemo(() => {
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      {
        visibleTurnItems,
        optimisticMessages: [],
        ...(projection === null
          ? {}
          : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
      },
      timelineProjectionRef.current,
    );
    timelineProjectionRef.current = next;
    return next.entries;
  }, [projection, visibleTurnItems]);
  const latestRun = useMemo(
    () => (projection === null ? null : deriveLatestThreadRun(projection)),
    [projection],
  );
  const activityRun = useMemo(
    () => (projection === null ? null : deriveThreadActivityRun(projection)),
    [projection],
  );
  const runtime = useMemo(
    () => (projection === null ? null : deriveThreadRuntime(projection)),
    [projection],
  );
  const isWorking = derivePhase(runtime) === "running";
  const workspaceRoot = projection?.thread.worktreePath ?? project?.workspaceRoot;
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });

  const openThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(childRef.environmentId, threadId)),
      });
    },
    [childRef.environmentId, navigate],
  );
  const onForkFromRun = useCallback(
    async (input: { readonly sourceThreadId: ThreadId; readonly runId: RunId }) => {
      const targetRef = scopeThreadRef(childRef.environmentId, newThreadId());
      const result = await forkFromRun({
        environmentId: childRef.environmentId,
        input: {
          sourceThreadId: input.sourceThreadId,
          targetThreadId: targetRef.threadId,
          runId: input.runId,
          title: `${projection?.thread.title ?? "Thread"} fork`,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({ type: "error", title: "Could not fork this response" });
        }
        return;
      }
      if (await waitForThreadShell(targetRef)) openThread(targetRef.threadId);
    },
    [childRef.environmentId, forkFromRun, openThread, projection?.thread.title],
  );

  return (
    // The panel sits beside the parent's chat, which owns find; this timeline is not searched.
    <ThreadFindTimelineContext value={null}>
      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        <MessagesTimeline
          isWorking={isWorking}
          activeTurnInProgress={isWorking || !isLatestRunSettled(latestRun, runtime)}
          activeTurnStartedAt={deriveActiveWorkStartedAt(activityRun, runtime, null)}
          isPreparingWorktree={activityRun?.status === "preparing"}
          awaitingUser={
            projection?.runtimeRequests.some((request) => request.status === "pending") === true
          }
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestRun={activityRun}
          runningRunId={runtime?.activeRunId ?? null}
          turnDiffSummaries={EMPTY_TURN_DIFFS}
          routeThreadKey={childKey}
          displayThreadKey={childKey}
          onOpenTurnDiff={props.onOpenFullThread}
          onOpenThread={openThread}
          onForkFromRun={onForkFromRun}
          onRollbackCheckpoint={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={childRef.environmentId}
          markdownCwd={workspaceRoot}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          providerStatuses={providers}
          runs={projection?.runs ?? []}
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled
          onIsAtEndChange={noop}
          onManualNavigation={noop}
        />
      </div>
    </ThreadFindTimelineContext>
  );
}

function DelegatedThreadSteer(props: {
  readonly childRef: ScopedThreadRef;
  readonly active: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const send = async () => {
    const message = text.trim();
    if (message.length === 0 || sending) return;
    setSending(true);
    const result = await startTurn({
      environmentId: props.childRef.environmentId,
      input: {
        threadId: props.childRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
        // Steers a turn in flight, or starts a follow-up once the thread settled.
        dispatchMode: "auto",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not send to this thread",
          description: error instanceof Error ? error.message : undefined,
        });
      }
      return;
    }
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <form
      className="flex items-end gap-1.5 border-t p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        size="sm"
        className="flex-1"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={props.active ? "Steer this thread…" : "Send a follow-up…"}
        aria-label={props.active ? "Steer this thread" : "Send a follow-up to this thread"}
        data-delegated-thread-steer
      />
      <Button
        type="submit"
        size="icon-sm"
        disabled={sending || text.trim().length === 0}
        aria-label={props.active ? "Steer" : "Send"}
      >
        <SendHorizontalIcon />
      </Button>
    </form>
  );
}
