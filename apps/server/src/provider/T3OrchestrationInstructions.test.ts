import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
  t3OrchestratorModePrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });

  it("restates orchestrator mode on each prompt once a thread has used it", () => {
    const prompt = "Add an export button and a settings page.";
    assert.equal(t3OrchestratorModePrompt({ prompt, orchestrator: undefined }), prompt);

    const on = t3OrchestratorModePrompt({ prompt, orchestrator: true });
    assert.include(on, "workspace='worktree'");
    assert.isTrue(on.endsWith(prompt));

    const off = t3OrchestratorModePrompt({ prompt, orchestrator: false });
    assert.include(off, "Orchestrator mode is off");
    assert.isTrue(off.endsWith(prompt));

    assert.equal(t3OrchestratorModePrompt({ prompt: "/compact", orchestrator: true }), "/compact");
  });

  it("lists an orchestrator's delegated threads so it can route the user's message", () => {
    const prompt = "Make the export button blue.";
    const routed = t3OrchestratorModePrompt({
      prompt,
      orchestrator: true,
      delegatedThreads: [
        {
          title: "Add CSV export",
          childThreadId: "thread:export",
          taskId: "node:export",
          branch: "t3/csv-export",
          state: "done",
        },
        {
          title: "Settings page",
          childThreadId: "thread:settings",
          taskId: "node:settings",
          branch: null,
          state: "working",
        },
      ],
    });
    assert.include(
      routed,
      [
        "<t3_code_delegated_threads>",
        '- "Add CSV export": done, childThreadId thread:export, taskId node:export, branch t3/csv-export',
        '- "Settings page": working, childThreadId thread:settings, taskId node:settings',
        "</t3_code_delegated_threads>",
      ].join("\n"),
    );
    assert.isTrue(routed.endsWith(prompt));
    assert.include(
      t3OrchestratorModePrompt({ prompt, orchestrator: true, delegatedThreads: [] }),
      "<t3_code_delegated_threads>\nNone yet.\n</t3_code_delegated_threads>",
    );
    // An unread list is left out rather than reported empty.
    assert.notInclude(
      t3OrchestratorModePrompt({ prompt, orchestrator: true }),
      "t3_code_delegated_threads",
    );
  });
});
