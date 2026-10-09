import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveLatestThreadRun,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import {
  AuthOrchestrationOperateScope,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext, terminalContextReference } from "../../lib/composerContextRecords";
import { removeInlineContextReference } from "../../lib/composerContextReferences";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { newMessageId, newThreadId } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../../state/server";
import {
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  derivePhase,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  isLatestRunSettled,
  type TimelineEntriesProjection,
} from "../../session-logic";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShell,
  useThreadStatus,
  useThreadVisibleTurnItems,
  waitForThreadShell,
} from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { resolveThreadSyncPhase } from "../../threadSync";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  deriveComposerSendState,
  deriveLockedProvider,
  formatOutgoingPrompt,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  resolveComposerModelPick,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";
import { ComposerSurface } from "./ComposerSurface";
import { MessagesTimeline } from "./MessagesTimeline";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { QueuedRunsControl } from "./QueuedRunsControl";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const EMPTY_OPTIMISTIC_MESSAGES: never[] = [];
const EMPTY_BANNERS: never[] = [];
const noop = () => undefined;

/**
 * A delegated thread's chat inside its tab: its own timeline and the same
 * composer the main chat uses, sending to the delegated thread. Main-chat
 * extras that need the full thread (compaction, several models at once,
 * editing queued messages, plan hand-off) are left to the full thread view.
 */
export function DelegatedThreadChat(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childRef: ScopedThreadRef;
}) {
  const { childRef } = props;
  const listRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    isAtEndRef.current = isAtEnd;
  }, []);
  const getTimelineScrollableNode = useCallback(
    () => listRef.current?.getScrollableNode() ?? null,
    [],
  );
  const isTimelineAtLogicalEnd = useCallback(
    () => resolveTimelineIsAtEnd(listRef.current?.getState()) ?? isAtEndRef.current,
    [],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-delegated-thread-chat>
      <DelegatedThreadTimeline
        parentRef={props.parentRef}
        childRef={childRef}
        listRef={listRef}
        onIsAtEndChange={onIsAtEndChange}
      />
      <DelegatedThreadComposer
        parentRef={props.parentRef}
        childRef={childRef}
        getTimelineScrollableNode={getTimelineScrollableNode}
        isTimelineAtLogicalEnd={isTimelineAtLogicalEnd}
      />
    </div>
  );
}

function DelegatedThreadTimeline(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childRef: ScopedThreadRef;
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
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
  const { turnDiffSummaries } = useTurnDiffSummaries(projection);
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
  // A turn's diff opens in this thread tab's Changes view.
  const openTurnDiff = useCallback(
    (runId: RunId, filePath?: string) => {
      useDiffPanelStore.getState().selectTurn(childRef, runId, filePath);
      useRightPanelStore
        .getState()
        .openDelegatedThread(props.parentRef, childRef.threadId, "changes");
    },
    [childRef, props.parentRef],
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
          listRef={props.listRef}
          timelineEntries={timelineEntries}
          latestRun={activityRun}
          runningRunId={runtime?.activeRunId ?? null}
          turnDiffSummaries={turnDiffSummaries}
          routeThreadKey={childKey}
          displayThreadKey={childKey}
          onOpenTurnDiff={openTurnDiff}
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
          onIsAtEndChange={props.onIsAtEndChange}
          onManualNavigation={noop}
        />
      </div>
    </ThreadFindTimelineContext>
  );
}

function DelegatedThreadComposer(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childRef: ScopedThreadRef;
  readonly getTimelineScrollableNode: () => HTMLElement | null;
  readonly isTimelineAtLogicalEnd: () => boolean;
}) {
  const { childRef } = props;
  const environmentId = childRef.environmentId;
  const threadId = childRef.threadId;
  const thread = useThreadShell(childRef);
  const projection = useThreadProjection(childRef)?.projection ?? null;
  const threadStatus = useThreadStatus(childRef);
  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const providerStatuses = useMemo(() => [...(serverConfig?.providers ?? [])], [serverConfig]);
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === thread?.projectId,
  );
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const draftRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(childRef)?.runtimeMode ?? null,
  );
  const draftInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(childRef)?.interactionMode ?? null,
  );
  const draftActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(childRef)?.activeProvider ?? null,
  );

  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const sendInFlightRef = useRef(false);
  const [sending, setSending] = useState(false);

  const runtime = useMemo(
    () => (projection === null ? null : deriveThreadRuntime(projection)),
    [projection],
  );
  const activityRun = useMemo(
    () => (projection === null ? null : deriveThreadActivityRun(projection)),
    [projection],
  );
  const phase = derivePhase(runtime);
  const supportsProviderSwitchingViaHandoff = useMemo(
    () => threadSupportsProviderHandoff(projection),
    [projection],
  );
  const lockedProvider = deriveLockedProvider({
    thread: thread ?? undefined,
    selectedProvider: draftActiveProvider,
    threadProvider: thread?.modelSelection.instanceId ?? null,
    providers: providerStatuses,
  });
  const runtimeMode: RuntimeMode = draftRuntimeMode ?? thread?.runtimeMode ?? "full-access";
  const interactionMode: ProviderInteractionMode =
    draftInteractionMode ?? thread?.interactionMode ?? "default";
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: projection !== null,
    shellExists: thread !== null,
    status: threadStatus,
  });
  const capabilities = serverConfig?.environment.capabilities;
  const supportsAttachmentUploads = capabilities?.attachmentUploads === true;
  const advertisedFileAttachmentBytes = capabilities?.fileAttachments?.maxUploadBytes ?? null;

  const setThreadError = useCallback((_threadId: ThreadId | null, error: string | null) => {
    if (error !== null) toastManager.add({ type: "error", title: error });
  }, []);
  const focusComposer = useCallback(() => composerRef.current?.focusAtEnd(), []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  }, []);

  const pending = usePendingThreadRequests({
    environmentId,
    threadId,
    projection,
    supportsQuestionAttachments: capabilities?.questionAttachments === true,
    composerDraftTarget: childRef,
    promptRef,
    composerRef,
    setThreadError,
  });

  const onInterrupt = useCallback(async () => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await interruptTurn({ environmentId, input: { threadId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        threadId,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  }, [environmentId, interruptTurn, setThreadError, threadId]);

  const onSend = async (
    event?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
  ) => {
    event?.preventDefault();
    if (sendInFlightRef.current || thread === null) return;
    if (pending.activePendingProgress) {
      pending.onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) return;
    const { images, files, terminalContexts, previewAnnotations, reviewComments, threadContexts } =
      sendCtx;
    const { sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
      prompt: sendCtx.prompt,
      imageCount: images.length + files.length,
      terminalContexts,
      elementContextCount:
        previewAnnotations.length + reviewComments.length + threadContexts.length,
    });
    if (!hasSendableContent) return;
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const messageText = terminalContexts
      .filter((context) => !sendableTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        sendCtx.prompt,
      )
      .trim();
    const text = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: messageText || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(text) === false) return;

    const attachments = [...images, ...files];
    // Capabilities can change across a reconnect while uploads run, so they are read live.
    const readLiveCapabilities = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const liveSupportsUploads = config?.environment.capabilities.attachmentUploads === true;
      return {
        supportsAttachmentUploads: liveSupportsUploads,
        supportsInlineMessageContext:
          config?.environment.capabilities.inlineMessageContext === true,
        fileBlockReason: fileAttachmentCapabilityBlockReason({
          files,
          attachmentUploadsCapabilityKnown: config !== null,
          supportsAttachmentUploads: liveSupportsUploads,
          maxFileAttachmentBytes:
            config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
        }),
      };
    };
    const before = readLiveCapabilities();
    if (before.fileBlockReason !== null) {
      setThreadError(threadId, before.fileBlockReason);
      return;
    }
    const usesUploads =
      files.length > 0 ? before.supportsAttachmentUploads : supportsAttachmentUploads;

    sendInFlightRef.current = true;
    setSending(true);
    try {
      if (usesUploads && attachments.length > 0) {
        for (const attachment of attachments) {
          startAttachmentUpload({ environmentId, image: attachment, draftTarget: childRef });
        }
        await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
        if (getUploadedAttachments({ environmentId, images: attachments }) === null) {
          setThreadError(threadId, "Retry or remove failed uploads before sending.");
          return;
        }
      }
      const turnAttachments = await Promise.all(
        attachments.map(async (attachment) => {
          if (usesUploads) {
            const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
            if (!uploaded) {
              throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
            }
            return uploaded;
          }
          if (attachment.type !== "image") {
            throw new Error("This server does not support file attachments.");
          }
          return {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl: await readFileAsDataUrl(attachment.file),
            ...(attachment.source ? { source: attachment.source } : {}),
          };
        }),
      );
      const live = readLiveCapabilities();
      if (live.fileBlockReason !== null) {
        setThreadError(threadId, live.fileBlockReason);
        return;
      }
      // Records bind attachments by the id the wire carries; the server rebinds them.
      const context = buildMessageContext({
        terminalContexts: sendableTerminalContexts,
        reviewComments,
        previewAnnotations,
        threadContexts,
        attachments: attachments.map((attachment, index) => {
          const sent = turnAttachments[index];
          return {
            attachment,
            attachmentId: sent !== undefined && "id" in sent && sent.id ? sent.id : attachment.id,
          };
        }),
      });
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: turnAttachments,
            ...(context === undefined
              ? {}
              : live.supportsInlineMessageContext
                ? { context }
                : { text: serializeLegacyContextMessage({ text, records: context.records }) }),
          },
          modelSelection: sendCtx.selectedModelSelection,
          runtimeMode,
          interactionMode: sendCtx.interactionMode,
          dispatchMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setThreadError(
            threadId,
            error instanceof Error ? error.message : "Could not send to this thread.",
          );
        }
        return;
      }
      promptRef.current = "";
      clearComposerContent(childRef);
      composerRef.current?.resetCursorState();
      if (usesUploads) releaseDraftAttachments(attachments);
    } catch (error) {
      setThreadError(
        threadId,
        error instanceof Error ? error.message : "Could not send to this thread.",
      );
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (thread === null) return null;
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: runtime !== null,
        supportsProviderSwitchingViaHandoff,
        currentModelSelection: thread.modelSelection,
        currentProviderInstanceId: runtime?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Open the full thread's composer to start over.` : null;
    },
    [providerStatuses, runtime, supportsProviderSwitchingViaHandoff, thread],
  );
  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string, options?: { focusComposer?: boolean }) => {
      if (thread === null) return;
      const pick = resolveComposerModelPick({
        instanceId,
        model,
        settings,
        providers: providerStatuses,
        lockedProvider,
        supportsProviderSwitchingViaHandoff,
        currentModelSelection: thread.modelSelection,
        hasStartedSession: runtime !== null,
        runtimeProviderInstanceId: runtime?.providerInstanceId ?? null,
        rememberedOptions: useComposerDraftStore.getState().stickyOptionsByModelByProvider,
      });
      if (pick.type === "blocked") {
        toastManager.add({ type: "warning", title: pick.title, description: pick.description });
      }
      if (pick.type === "selected") {
        setComposerDraftModelSelection(childRef, pick.selection, {
          explicit: true,
          replaceOptions: true,
        });
        setStickyModelSelection(pick.selection);
      }
      if (options?.focusComposer !== false) scheduleComposerFocus();
    },
    [
      childRef,
      lockedProvider,
      providerStatuses,
      runtime,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyModelSelection,
      settings,
      supportsProviderSwitchingViaHandoff,
      thread,
    ],
  );
  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(childRef, mode);
      scheduleComposerFocus();
    },
    [childRef, runtimeMode, scheduleComposerFocus, setComposerDraftRuntimeMode],
  );
  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(childRef, mode);
      scheduleComposerFocus();
    },
    [childRef, interactionMode, scheduleComposerFocus, setComposerDraftInteractionMode],
  );
  const toggleInteractionMode = useCallback(
    () => handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan"),
    [handleInteractionModeChange, interactionMode],
  );
  const navigate = useNavigate();
  const openProviderSetup = useCallback(
    (instanceId: ProviderInstanceId) => {
      void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
    },
    [environmentId, navigate],
  );

  if (thread === null) return null;
  return (
    <div className="shrink-0 px-2 pb-2" data-delegated-thread-composer>
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ChatComposer
            scopeShortcutsToFocus
            canOperateThread={canOperateThread}
            reportedModelSelection={null}
            multipleModelSelections={null}
            supportsMultipleModels={false}
            onMultipleModelSelectionsChange={noop}
            composerRef={composerRef}
            composerDraftTarget={childRef}
            environmentId={environmentId}
            attachmentUploadsCapabilityKnown={serverConfig !== null}
            supportsAttachmentUploads={supportsAttachmentUploads}
            supportsQuestionAttachments={capabilities?.questionAttachments === true}
            maxFileAttachmentBytes={
              advertisedFileAttachmentBytes === null
                ? null
                : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes)
            }
            routeKind="server"
            routeThreadRef={childRef}
            draftId={null}
            activeThreadId={threadId}
            activeThreadEnvironmentId={environmentId}
            activeThread={thread}
            activeThreadShell={thread}
            promptHistoryMessages={EMPTY_OPTIMISTIC_MESSAGES}
            isServerThread
            isLocalDraftThread={false}
            forceExpandedOnMobile={false}
            projectSelectionRequired={false}
            phase={phase}
            canInterrupt={canOperateThread && deriveCanInterruptRunningThread(true, runtime)}
            isConnecting={false}
            isSendBusy={sending}
            canResume={false}
            sendDisabledReason={
              !canOperateThread
                ? "This connection cannot change threads."
                : threadSyncPhase === "loading"
                  ? "Messages loading"
                  : null
            }
            isPreparingWorktree={activityRun?.status === "preparing"}
            queuedRunsControl={
              <QueuedRunsControl
                environmentId={environmentId}
                threadId={threadId}
                optimisticMessages={EMPTY_OPTIMISTIC_MESSAGES}
                editingRunId={null}
                onCancelEdit={noop}
              />
            }
            bannerItems={EMPTY_BANNERS}
            resumeCompactionTokens={null}
            keepFullHistory={false}
            onToggleKeepFullHistory={noop}
            environmentUnavailable={null}
            activePendingApproval={pending.activePendingApproval}
            pendingApprovals={pending.pendingApprovals}
            pendingUserInputs={pending.pendingUserInputs}
            activePendingProgress={pending.activePendingProgress}
            activePendingResolvedAnswers={pending.activePendingResolvedAnswers}
            activePendingIsResponding={pending.activePendingIsResponding}
            activePendingDraftAnswers={pending.activePendingDraftAnswers}
            activePendingQuestionIndex={pending.activePendingQuestionIndex}
            respondingRequestIds={pending.respondingRequestIds}
            showPlanFollowUpPrompt={false}
            activeProposedPlan={null}
            threadSyncPhase={threadSyncPhase}
            runtimeMode={runtimeMode}
            interactionMode={interactionMode}
            lockedProvider={supportsProviderSwitchingViaHandoff ? null : lockedProvider}
            providerStatuses={providerStatuses}
            providerCatalogKnown={serverConfig !== null}
            activeProjectDefaultModelSelection={null}
            activeThreadModelSelection={thread.modelSelection}
            activeContextWindow={null}
            activeTasksProgress={null}
            activeTaskSteps={null}
            compactThreadUnavailable
            compactDisabled
            compactDisabledReason={null}
            resolvedTheme={resolvedTheme}
            settings={settings}
            keybindings={keybindings}
            terminalOpen={false}
            gitCwd={thread.worktreePath ?? project?.workspaceRoot ?? null}
            pullRequestProjectId={null}
            pullRequestRepository={null}
            restingControlsHost={null}
            restingControlsHaveLeadingContext={false}
            onRestingControlsVisibilityChange={noop}
            getTimelineScrollableNode={props.getTimelineScrollableNode}
            isTimelineAtLogicalEnd={props.isTimelineAtLogicalEnd}
            timelineOverflows
            onComposerOverlayHeightChange={noop}
            onRestingChange={noop}
            promptRef={promptRef}
            composerImagesRef={composerImagesRef}
            composerFilesRef={composerFilesRef}
            composerTerminalContextsRef={composerTerminalContextsRef}
            onPageScrollKeyDown={noop}
            onPageScrollKeyUp={noop}
            onPageScrollRelease={noop}
            onCompactContext={noop}
            onSend={(event, dispatchMode) => void onSend(event, dispatchMode)}
            onResume={noop}
            onInterrupt={() => void onInterrupt()}
            onImplementPlanInNewThread={noop}
            onRespondToApproval={pending.onRespondToApproval}
            onSelectActivePendingUserInputOption={pending.onSelectActivePendingUserInputOption}
            onAdvanceActivePendingUserInput={pending.onAdvanceActivePendingUserInput}
            onDismissActivePendingUserInput={(requestId) =>
              void pending.onDismissUserInput(requestId)
            }
            onPreviousActivePendingUserInputQuestion={
              pending.onPreviousActivePendingUserInputQuestion
            }
            onChangeActivePendingUserInputCustomAnswer={
              pending.onChangeActivePendingUserInputCustomAnswer
            }
            onProviderModelSelect={onProviderModelSelect}
            onOpenProviderSetup={openProviderSetup}
            getModelDisabledReason={getModelDisabledReason}
            toggleInteractionMode={toggleInteractionMode}
            handleRuntimeModeChange={handleRuntimeModeChange}
            handleInteractionModeChange={handleInteractionModeChange}
            orchestratorMode={null}
            onToggleOrchestratorMode={noop}
            focusComposer={focusComposer}
            scheduleComposerFocus={scheduleComposerFocus}
            setThreadError={setThreadError}
            onExpandImage={noop}
            onFileOpen={(attachment) =>
              useRightPanelStore.getState().openAttachment(props.parentRef, attachment)
            }
            editingQueuedAttachments={null}
            onRemoveEditingQueuedAttachment={noop}
          />
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
