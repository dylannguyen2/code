import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ThreadId,
  type UserInputAttachments,
} from "@t3tools/contracts";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { getUploadedAttachments, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  clearQuestionAttachmentDraft,
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatComposerHandle } from "./ChatComposer";

const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

/**
 * A thread's open approvals and questions, and the composer's answers to them.
 * The composer shows the first of each and steps through a question's parts;
 * answers live here until they are sent, keyed by request.
 */
export function usePendingThreadRequests(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly supportsQuestionAttachments: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly promptRef: RefObject<string>;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
}) {
  const {
    environmentId,
    threadId,
    projection,
    supportsQuestionAttachments,
    composerDraftTarget,
    promptRef,
    composerRef,
    setThreadError,
  } = input;
  const respondToThreadApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissThreadUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    RuntimeRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});

  const pendingRequests = useMemo(
    () =>
      projection === null
        ? { approvals: [], userInputs: [] }
        : derivePendingThreadRequests(projection),
    [projection],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(pendingRequests.approvals),
    [pendingRequests.approvals],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(pendingRequests.userInputs),
    [pendingRequests.userInputs],
  );
  const activePendingApproval = pendingApprovals[0] ?? null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingRequestKey = JSON.stringify([
    environmentId,
    threadId,
    activePendingUserInput?.requestId,
  ]);
  const pendingQuestionDraftKeys = useMemo(
    () =>
      threadId
        ? pendingUserInputs.flatMap((request) =>
            request.questions.map((question) =>
              questionAttachmentDraftId(environmentId, threadId, request.requestId, question.id),
            ),
          )
        : [],
    [threadId, environmentId, pendingUserInputs],
  );
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => [key, state.draftsByThreadKey[key]]),
      ),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some((attachment) => {
              const upload = state.uploadsByImageId[attachment.id];
              return upload?.status !== "ready" || upload.environmentId !== environmentId;
            }),
          ];
        }),
      ),
    ),
  );
  const questionPreparations = useQuestionAttachmentPreparation(
    useShallow((state) =>
      Object.fromEntries(pendingQuestionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  // Attachments drafted for questions that are no longer open are released.
  useEffect(() => {
    if (!threadId) return;
    const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
    const retained = new Set(
      pendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(environmentId, threadId, request.requestId, question.id),
        ),
      ),
    );
    const keys = new Set([
      ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
      ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix) && !retained.has(key as DraftId))
        clearQuestionAttachmentDraft(key as DraftId);
    }
  }, [environmentId, threadId, pendingUserInputs]);
  const activePendingDraftAnswers = useMemo(() => {
    if (!activePendingUserInput || !threadId) return EMPTY_PENDING_USER_INPUT_ANSWERS;
    return Object.fromEntries(
      activePendingUserInput.questions.map((question) => {
        const key = questionAttachmentDraftId(
          environmentId,
          threadId,
          activePendingUserInput.requestId,
          question.id,
        );
        const draft = questionComposerDrafts[key];
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        return [
          question.id,
          {
            ...pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[question.id],
            attachmentCount: attachments.length,
            attachmentsBlocked:
              (attachments.length > 0 && !supportsQuestionAttachments) ||
              (questionPreparations[key] ?? 0) > 0 ||
              questionUploadsBlocked[key] === true,
          },
        ];
      }),
    );
  }, [
    activePendingUserInput,
    threadId,
    environmentId,
    questionComposerDrafts,
    questionUploadsBlocked,
    supportsQuestionAttachments,
    questionPreparations,
    pendingUserInputAnswersByRequestId,
    activePendingRequestKey,
  ]);
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingRequestKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? activePendingUserInput.responseCapability === "not_resumable" ||
      respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;

  const onRespondToApproval = useCallback(
    async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      if (!threadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
      if (
        pendingApprovals.find((approval) => approval.requestId === requestId)
          ?.responseCapability !== "live"
      )
        return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: { threadId, requestId, decision },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [threadId, environmentId, pendingApprovals, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: RuntimeRequestId, answers: Record<string, unknown>) => {
      if (!threadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
      const pendingInput = pendingUserInputs.find((entry) => entry.requestId === requestId);
      if (!pendingInput || pendingInput.responseCapability === "not_resumable") return;
      const responseKey = JSON.stringify([environmentId, threadId, requestId]);
      if (userInputResponsesInFlight.current.has(responseKey)) return;
      const attachmentsByQuestionId = new Map<string, UserInputAttachments[string]>();
      for (const question of pendingInput.questions) {
        const target = questionAttachmentDraftId(environmentId, threadId, requestId, question.id);
        if ((useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0) return;
        const draft = useComposerDraftStore.getState().getComposerDraft(target);
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        if (attachments.length === 0) continue;
        const uploaded = getUploadedAttachments({ environmentId, images: attachments });
        if (!uploaded) {
          setThreadError(
            threadId,
            "Wait for attachments to finish uploading, or remove failed uploads.",
          );
          return;
        }
        attachmentsByQuestionId.set(question.id, uploaded as UserInputAttachments[string]);
      }
      userInputResponsesInFlight.current.add(responseKey);

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId,
          requestId,
          answers,
          ...(attachmentsByQuestionId.size > 0
            ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
            : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      userInputResponsesInFlight.current.delete(responseKey);
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [threadId, environmentId, pendingUserInputs, respondToThreadUserInput, setThreadError],
  );

  // Closes an async question without messaging the agent. The server records
  // the dismissal so every client releases the composer.
  const onDismissUserInput = useCallback(
    async (requestId: RuntimeRequestId) => {
      if (!threadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await dismissThreadUserInput({
        environmentId,
        input: { threadId, requestId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to dismiss the question.",
        );
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [threadId, dismissThreadUserInput, environmentId, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingRequestKey]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput, activePendingRequestKey],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionValue: string) => {
      if (!activePendingUserInput) {
        return;
      }
      // The option replaces the custom answer. Anything typed there is the
      // user's text, so it goes back to the thread draft instead of vanishing.
      const displacedAnswer =
        pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[questionId]?.customAnswer;
      const currentPrompt =
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
      const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displacedAnswer);
      if (nextPrompt !== currentPrompt) {
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingRequestKey]: {
            ...existing[activePendingRequestKey],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingRequestKey]?.[questionId],
              optionValue,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      activePendingRequestKey,
      composerDraftTarget,
      composerRef,
      pendingUserInputAnswersByRequestId,
      promptRef,
      setComposerDraftPrompt,
    ],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question || question.allowCustomAnswer === false) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingRequestKey]: {
          ...existing[activePendingRequestKey],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingRequestKey]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, activePendingRequestKey, composerRef, promptRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingProgress
    ) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  return {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval,
    onDismissUserInput,
    onSelectActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  };
}
