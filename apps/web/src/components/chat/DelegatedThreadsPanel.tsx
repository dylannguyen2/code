import {
  delegatedThreadIsActive,
  deriveDelegatedThreadRows,
  summarizeDelegatedThreads,
  type DelegatedThreadRow,
} from "@t3tools/client-runtime/state/delegated-threads";
import type { OrchestrationV2ThreadShell, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon, GitBranchIcon, ListChecksIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { ScrollArea } from "../ui/scroll-area";
import { AgentElapsed } from "./AgentElapsed";
import { DelegatedThreadStateIcon, STATE_PRESENTATION } from "./DelegatedThreadStateIcon";

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

/** The checklist of threads `threadRef` delegated; each opens in its own tab. */
export function DelegatedThreadsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly orchestrator: boolean;
}) {
  const rows = useDelegatedThreadRows(props.threadRef);
  const open = useCallback(
    (threadId: ThreadId) =>
      useRightPanelStore.getState().openDelegatedThread(props.threadRef, threadId),
    [props.threadRef],
  );
  return <DelegatedThreadList rows={rows} orchestrator={props.orchestrator} onSelect={open} />;
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
  const settled = !delegatedThreadIsActive(row.state);
  return (
    <button
      type="button"
      onClick={() => props.onSelect(row.threadId)}
      data-delegated-thread-row={row.state}
      className="group flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <DelegatedThreadStateIcon state={row.state} className="mt-0.5 size-4" />
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

export function DelegatedThreadMeta(props: { readonly row: DelegatedThreadRow }) {
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

/** One delegated thread's checklist row, read from its orchestrator's task and its own shell. */
export function useDelegatedThreadRow(
  parentRef: ScopedThreadRef,
  threadId: ThreadId,
): DelegatedThreadRow | null {
  const rows = useDelegatedThreadRows(parentRef);
  return useMemo(() => rows.find((row) => row.threadId === threadId) ?? null, [rows, threadId]);
}
