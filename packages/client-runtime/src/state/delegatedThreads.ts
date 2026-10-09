import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Where a delegated thread stands, as its checklist row shows it. */
export type DelegatedThreadState =
  | "preparing"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "stopped";

export interface DelegatedThreadRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly state: DelegatedThreadState;
  readonly branch: string | null;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string | null;
  /** When the current work started, for an elapsed timer. Null once settled. */
  readonly activeSince: string | null;
}

export interface DelegatedThreadProgress {
  readonly done: number;
  readonly active: number;
  readonly total: number;
}

function stateFromShell(shell: OrchestrationV2ThreadShell): DelegatedThreadState | null {
  if (shell.pendingRuntimeRequest !== null) return "waiting";
  switch (shell.activityRunStatus) {
    case "preparing":
    case "starting":
      return "preparing";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    default:
      return null;
  }
}

function stateFromTask(task: OrchestrationV2Subagent): DelegatedThreadState {
  switch (task.status) {
    case "completed":
    case "idle":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "waiting":
      return "waiting";
    case "pending":
    case "running":
      return "running";
  }
}

/**
 * The app-owned threads a thread delegated, in delegation order. The task
 * record settles with the child's first run, while the parent or the user can
 * keep the child working afterwards, so a live run on the child thread
 * outranks the settled task.
 */
export function deriveDelegatedThreadRows(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly shellsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
}): ReadonlyArray<DelegatedThreadRow> {
  const rows: DelegatedThreadRow[] = [];
  for (const task of input.subagents) {
    if (task.origin !== "app_owned" || task.childThreadId === null) continue;
    const shell = input.shellsById.get(task.childThreadId);
    if (shell?.deletedAt != null) continue;
    const liveState = shell ? stateFromShell(shell) : null;
    const state = liveState ?? stateFromTask(task);
    const activeStartedAt =
      liveState === null
        ? state === "running" || state === "waiting"
          ? task.startedAt
          : null
        : (shell?.activityRunStartedAt ?? null);
    rows.push({
      threadId: task.childThreadId,
      title: shell?.title ?? task.title ?? task.prompt,
      state,
      branch: shell?.branch ?? null,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      model: task.model,
      activeSince: activeStartedAt === null ? null : DateTime.formatIso(activeStartedAt),
    });
  }
  return rows;
}

/**
 * Where a delegated thread stands from its own shell, for places that do not
 * read its task. A settled thread reads as its latest run ended.
 */
export function delegatedThreadStateFromShell(
  shell: OrchestrationV2ThreadShell,
): DelegatedThreadState {
  const live = stateFromShell(shell);
  if (live !== null) return live;
  switch (shell.status) {
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "queued":
    case "preparing":
    case "starting":
      return "preparing";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "idle":
    case "completed":
    case "rolled_back":
      return "done";
  }
}

export function summarizeDelegatedThreads(
  rows: ReadonlyArray<DelegatedThreadRow>,
): DelegatedThreadProgress {
  let done = 0;
  let active = 0;
  for (const row of rows) {
    if (row.state === "done") done += 1;
    else if (row.state === "preparing" || row.state === "running" || row.state === "waiting") {
      active += 1;
    }
  }
  return { done, active, total: rows.length };
}

/** Only a settled thread takes a fresh turn; a working one is steered in flight. */
export function delegatedThreadIsActive(state: DelegatedThreadState): boolean {
  return state === "preparing" || state === "running" || state === "waiting";
}
