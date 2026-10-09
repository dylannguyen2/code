import {
  CommandId,
  MessageId,
  type NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2PlanArtifact,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * An orchestrator's chat is where its user reads, but delegated work can run
 * for an hour between results. While its threads work, an orchestrator that
 * has been quiet this long gets a check-in to write the user an update, once
 * some thread has made progress since its last one.
 */
export const CHECK_IN_AFTER_QUIET_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const MESSAGE_EXCERPT_LIMIT = 600;

/** Where one working delegated thread stands. */
export interface DelegatedThreadProgress {
  readonly childThreadId: ThreadId;
  readonly taskId: NodeId;
  readonly title: string;
  readonly workingForMs: number | null;
  readonly waitingForInput: boolean;
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly currentStep: string | null;
  /** The thread's latest finished message in its current work. */
  readonly latestMessage: { readonly id: MessageId; readonly text: string } | null;
}

/** What the orchestrator last heard about a thread. */
export interface ReportedProgress {
  readonly stepsDone: number;
  readonly currentStep: string | null;
  readonly messageId: MessageId | null;
}

export const reportedProgressOf = (progress: DelegatedThreadProgress): ReportedProgress => ({
  stepsDone: progress.stepsDone,
  currentStep: progress.currentStep,
  messageId: progress.latestMessage?.id ?? null,
});

const madeProgress = (progress: DelegatedThreadProgress, reported: ReportedProgress) =>
  progress.stepsDone !== reported.stepsDone ||
  progress.currentStep !== reported.currentStep ||
  (progress.latestMessage?.id ?? null) !== reported.messageId;

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_EXCERPT_LIMIT ? `${flat.slice(0, MESSAGE_EXCERPT_LIMIT)}…` : flat;
};

function progressLine(progress: DelegatedThreadProgress, reported: ReportedProgress): string {
  const parts = [`"${progress.title}" (childThreadId ${progress.childThreadId})`];
  if (progress.workingForMs !== null) {
    parts.push(`working for ${Math.max(1, Math.round(progress.workingForMs / 60_000))} min`);
  }
  if (progress.waitingForInput) parts.push("waiting for input");
  if (progress.stepsTotal > 0) {
    const newlyDone = progress.stepsDone - reported.stepsDone;
    parts.push(
      `${progress.stepsDone} of ${progress.stepsTotal} steps done${newlyDone > 0 ? ` (${newlyDone} since your last update)` : ""}`,
    );
  }
  if (progress.currentStep !== null) parts.push(`on "${progress.currentStep}"`);
  const line = `- ${parts.join(", ")}.`;
  if (!madeProgress(progress, reported)) return `${line} No new progress since your last update.`;
  return progress.latestMessage !== null && progress.latestMessage.id !== reported.messageId
    ? `${line} Its latest message: "${excerpt(progress.latestMessage.text)}"`
    : line;
}

/**
 * The check-in for one orchestrator, or null when none of its working threads
 * made progress since it last heard about them. A thread it has not heard
 * about yet counts from where it stands now.
 */
export function progressCheckIn(input: {
  readonly threads: ReadonlyArray<DelegatedThreadProgress>;
  readonly reported: ReadonlyMap<ThreadId, ReportedProgress>;
  readonly quietForMs: number;
}): { readonly text: string; readonly detail: string } | null {
  if (input.quietForMs < CHECK_IN_AFTER_QUIET_MS) return null;
  const rows = input.threads.map((progress) => ({
    progress,
    reported: input.reported.get(progress.childThreadId) ?? reportedProgressOf(progress),
  }));
  if (!rows.some(({ progress, reported }) => madeProgress(progress, reported))) return null;
  const detail = rows.map(({ progress, reported }) => progressLine(progress, reported)).join("\n");
  const minutes = Math.round(input.quietForMs / 60_000);
  return {
    detail,
    text: `Progress check-in: your delegated threads are still working and this chat has been quiet for ${minutes} minutes. Write the user a short update on what changed since your last message: a line or two per thread with progress (steps finished, what it is on now, anything notable it reported), and a brief mention of threads with no news. Message a thread only if something needs correcting, then end your turn.\n\n${detail}`,
  };
}

const latestChecklist = (plans: ReadonlyArray<OrchestrationV2PlanArtifact>) => {
  const plan = plans.findLast(
    (candidate) => candidate.kind === "todo_list" && candidate.steps.length > 0,
  );
  return plan?.kind === "todo_list" ? plan.steps : [];
};

/** One sweep over every orchestrator; it runs at most once a minute. */
export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // In memory: after a restart, each thread counts from where it then stands.
  const reportedRef = yield* Ref.make(new Map<ThreadId, ReportedProgress>());
  const lastSweepRef = yield* Ref.make(0);

  const workingThreadsOf = (parentThreadId: ThreadId, nowMs: number) =>
    Effect.gen(function* () {
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
      const working: Array<DelegatedThreadProgress> = [];
      for (const task of parent.subagents) {
        if (task.origin !== "app_owned" || task.childThreadId === null) continue;
        const shell = yield* projections.getThreadShell(task.childThreadId);
        if (
          shell === null ||
          shell.archivedAt !== null ||
          shell.deletedAt !== null ||
          shell.activityRunStatus == null ||
          shell.activeRunId === null
        ) {
          continue;
        }
        const child = yield* projections.getThreadRecords(
          task.childThreadId,
          ["plans", "messages"],
          { messageRoles: ["assistant"], messageRunIds: [shell.activeRunId] },
        );
        const steps = latestChecklist(child.plans);
        const latestMessage = child.messages.findLast(
          (message) => !message.streaming && message.text.trim() !== "",
        );
        working.push({
          childThreadId: task.childThreadId,
          taskId: task.id,
          title: shell.title,
          workingForMs:
            shell.activityRunStartedAt == null
              ? null
              : nowMs - DateTime.toEpochMillis(shell.activityRunStartedAt),
          waitingForInput:
            shell.activityRunStatus === "waiting" || shell.pendingRuntimeRequest !== null,
          stepsDone: steps.filter((step) => step.status === "completed").length,
          stepsTotal: steps.length,
          currentStep: steps.find((step) => step.status === "running")?.text ?? null,
          latestMessage:
            latestMessage === undefined ? null : { id: latestMessage.id, text: latestMessage.text },
        });
      }
      return working;
    });

  const checkIn = (parentThreadId: ThreadId, nowMs: number) =>
    Effect.gen(function* () {
      const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
      // A turn in flight or waiting in the queue speaks for it soon enough.
      const finishedAt = parent.runs.flatMap((run) =>
        run.completedAt === null ? [] : [DateTime.toEpochMillis(run.completedAt)],
      );
      if (finishedAt.length === 0 || finishedAt.length < parent.runs.length) return;
      const lastSpokeMs = Math.max(...finishedAt);
      const working = yield* workingThreadsOf(parentThreadId, nowMs);
      const reported = yield* Ref.get(reportedRef);
      const update = progressCheckIn({
        threads: working,
        reported,
        quietForMs: nowMs - lastSpokeMs,
      });
      if (update === null) {
        // First sight of a thread is its baseline; later progress accumulates.
        yield* Ref.update(reportedRef, (current) => {
          const next = new Map(current);
          for (const progress of working) {
            if (!next.has(progress.childThreadId)) {
              next.set(progress.childThreadId, reportedProgressOf(progress));
            }
          }
          return next;
        });
        return;
      }
      const command: OrchestrationV2Command = {
        type: "message.dispatch",
        commandId: CommandId.make(`server:delegated-progress:${parentThreadId}:${nowMs}`),
        messageId: MessageId.make(`message:delegated-progress:${parentThreadId}:${nowMs}`),
        threadId: parentThreadId,
        text: update.text,
        notification: {
          source: { kind: "delegated_task", taskIds: working.map((progress) => progress.taskId) },
          outcome: "updated",
          summary: `Progress check-in: ${working.length} thread${working.length === 1 ? "" : "s"} working`,
          detail: update.detail,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      };
      yield* threads.dispatch(command);
      yield* Ref.update(reportedRef, (current) => {
        const next = new Map(current);
        for (const progress of working) {
          next.set(progress.childThreadId, reportedProgressOf(progress));
        }
        return next;
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.delegated-progress.check-in-failed", {
          threadId: parentThreadId,
          cause,
        }),
      ),
    );

  return Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs - (yield* Ref.get(lastSweepRef)) < SWEEP_EVERY_MS) return;
    yield* Ref.set(lastSweepRef, nowMs);
    const parents = yield* projections.getOrchestratorThreadIds();
    yield* Effect.forEach(parents, (parentThreadId) => checkIn(parentThreadId, nowMs), {
      discard: true,
    });
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("delegated-progress-check-ins", sweep);
  }),
);
