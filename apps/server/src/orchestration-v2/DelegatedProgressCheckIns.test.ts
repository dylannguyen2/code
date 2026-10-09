import { MessageId, NodeId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  CHECK_IN_AFTER_QUIET_MS,
  type DelegatedThreadProgress,
  progressCheckIn,
  reportedProgressOf,
} from "./DelegatedProgressCheckIns.ts";

const thread = (
  name: string,
  overrides: Partial<DelegatedThreadProgress> = {},
): DelegatedThreadProgress => ({
  childThreadId: ThreadId.make(`thread:${name}`),
  taskId: NodeId.make(`task:${name}`),
  title: name,
  workingForMs: 30 * 60_000,
  waitingForInput: false,
  stepsDone: 1,
  stepsTotal: 4,
  currentStep: "Reproduce the race",
  latestMessage: { id: MessageId.make(`message:${name}:1`), text: "Started." },
  ...overrides,
});

describe("progressCheckIn", () => {
  const docs = thread("Docs sweep");
  const flaky = thread("Flaky test fix");
  const reported = new Map(
    [docs, flaky].map((row) => [row.childThreadId, reportedProgressOf(row)]),
  );

  it("waits out the quiet stretch and stays silent without progress", () => {
    const progressed = { ...docs, stepsDone: 2, currentStep: "Update the CLI reference" };
    assert.isNull(
      progressCheckIn({
        threads: [progressed, flaky],
        reported,
        quietForMs: CHECK_IN_AFTER_QUIET_MS - 60_000,
      }),
    );
    assert.isNull(progressCheckIn({ threads: [docs, flaky], reported, quietForMs: 60 * 60_000 }));
  });

  it("reports what changed and names threads with no news", () => {
    const update = progressCheckIn({
      threads: [{ ...docs, stepsDone: 3, currentStep: "Update the CLI reference" }, flaky],
      reported,
      quietForMs: 15 * 60_000,
    });
    assert.equal(
      update?.detail,
      [
        `- "Docs sweep" (childThreadId thread:Docs sweep), working for 30 min, 3 of 4 steps done (2 since your last update), on "Update the CLI reference".`,
        `- "Flaky test fix" (childThreadId thread:Flaky test fix), working for 30 min, 1 of 4 steps done, on "Reproduce the race". No new progress since your last update.`,
      ].join("\n"),
    );
    assert.include(update?.text ?? "", "quiet for 15 minutes");
  });
});
