import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  delegatedThreadStateFromShell,
  deriveDelegatedThreadRows,
  latestDelegatedThreadChecklist,
  summarizeDelegatedThreads,
} from "./delegatedThreads.ts";

const startedAt = DateTime.makeUnsafe("2026-10-08T12:00:00.000Z");

function task(
  childThreadId: string | null,
  status: OrchestrationV2Subagent["status"],
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`node:${childThreadId}`),
    threadId: ThreadId.make("orchestrator"),
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: childThreadId === null ? null : ThreadId.make(childThreadId),
    nativeTaskRef: null,
    prompt: `Prompt for ${childThreadId}`,
    title: null,
    model: "gpt-5.4",
    status,
    result: null,
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
    ...overrides,
  };
}

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): readonly [ThreadId, OrchestrationV2ThreadShell] {
  return [
    ThreadId.make(id),
    {
      id: ThreadId.make(id),
      title: `Thread ${id}`,
      branch: `feature/${id}`,
      activityRunStatus: null,
      activityRunStartedAt: null,
      pendingRuntimeRequest: null,
      deletedAt: null,
      ...overrides,
    } as OrchestrationV2ThreadShell,
  ];
}

describe("delegated threads", () => {
  it("lists app-owned children in delegation order with live child state first", () => {
    const followUpStartedAt = DateTime.makeUnsafe("2026-10-08T12:30:00.000Z");
    const rows = deriveDelegatedThreadRows({
      subagents: [
        task("settings", "running"),
        task(null, "running"),
        task("native", "running", { origin: "provider_native" }),
        // Settled with its first run, but the user steered it into another turn.
        task("export", "completed"),
        task("docs", "failed"),
        task("search", "running"),
      ],
      shellsById: new Map([
        shell("settings", { activityRunStatus: "preparing", activityRunStartedAt: startedAt }),
        shell("export", { activityRunStatus: "running", activityRunStartedAt: followUpStartedAt }),
        shell("docs"),
        shell("search", {
          activityRunStatus: "running",
          pendingRuntimeRequest: {} as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
        }),
      ]),
    });

    expect(rows.map((row) => [row.threadId, row.state, row.branch])).toEqual([
      ["settings", "preparing", "feature/settings"],
      ["export", "running", "feature/export"],
      ["docs", "failed", "feature/docs"],
      ["search", "waiting", "feature/search"],
    ]);
    expect(rows[1]?.activeSince).toBe("2026-10-08T12:30:00.000Z");
    expect(rows[2]?.activeSince).toBeNull();
    expect(summarizeDelegatedThreads(rows)).toEqual({ done: 0, active: 3, total: 4 });
  });

  it("falls back to the task record before the child shell arrives, and hides deleted children", () => {
    const rows = deriveDelegatedThreadRows({
      subagents: [
        task("loading", "running", { title: "Add the export button" }),
        task("finished", "completed"),
        task("stopped", "interrupted"),
        task("deleted", "completed"),
      ],
      shellsById: new Map([
        shell("finished"),
        shell("stopped"),
        shell("deleted", { deletedAt: startedAt }),
      ]),
    });

    expect(rows.map((row) => [row.title, row.state])).toEqual([
      ["Add the export button", "running"],
      ["Thread finished", "done"],
      ["Thread stopped", "stopped"],
    ]);
    expect(rows[0]?.activeSince).toBe("2026-10-08T12:00:00.000Z");
    expect(summarizeDelegatedThreads(rows)).toEqual({ done: 1, active: 1, total: 3 });
  });

  it("reads a thread's state from its shell alone, live work first", () => {
    const stateOf = (overrides: Partial<OrchestrationV2ThreadShell>) =>
      delegatedThreadStateFromShell(shell("child", overrides)[1]);
    expect(stateOf({ activityRunStatus: "running", status: "completed" })).toBe("running");
    expect(
      stateOf({
        activityRunStatus: "running",
        pendingRuntimeRequest: {} as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
      }),
    ).toBe("waiting");
    expect(stateOf({ status: "completed" })).toBe("done");
    expect(stateOf({ status: "failed" })).toBe("failed");
    expect(stateOf({ status: "interrupted" })).toBe("stopped");
  });

  it("shows the latest checklist a thread wrote, skipping proposed plans and empty lists", () => {
    const steps = (texts: ReadonlyArray<string>) =>
      texts.map((text, index) => ({
        id: `${text}-${index}`,
        text,
        status: index === 0 ? ("completed" as const) : ("pending" as const),
      }));
    const plan = (kind: "todo_list" | "proposed_plan", texts: ReadonlyArray<string>) =>
      (kind === "todo_list"
        ? { kind, steps: steps(texts) }
        : { kind, markdown: texts.join("\n") }) as unknown as OrchestrationV2PlanArtifact;
    expect(latestDelegatedThreadChecklist(null)).toBeNull();
    expect(
      latestDelegatedThreadChecklist({
        plans: [
          plan("todo_list", ["Read the code", "Add the toggle"]),
          plan("todo_list", ["Remember the choice", "Commit"]),
          plan("proposed_plan", ["A plan, not a checklist"]),
          plan("todo_list", []),
        ],
      })?.map((step) => [step.text, step.status]),
    ).toEqual([
      ["Remember the choice", "completed"],
      ["Commit", "pending"],
    ]);
  });
});
