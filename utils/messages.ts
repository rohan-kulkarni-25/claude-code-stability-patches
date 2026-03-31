/**
 * Message utilities for Claude Code.
 *
 * This barrel re-exports all message functionality from sub-modules in utils/messages/.
 */

// Constants, rejection messages, simple checks
export {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  CANCEL_MESSAGE,
  DENIAL_WORKAROUND_GUIDANCE,
  deriveShortMessageId,
  deriveUUID,
  DONT_ASK_REJECT_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isClassifierDenial,
  isSyntheticMessage,
  NO_RESPONSE_REQUESTED,
  PLAN_PHASE4_CONTROL,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_MODEL,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  withMemoryCorrectionHint,
} from './messages/messageConstants.js'

// Message creation / factory functions
export {
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createAwaySummaryMessage,
  createBridgeStatusMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMemorySavedMessage,
  createMicrocompactBoundaryMessage,
  createModelSwitchBreadcrumbs,
  createPermissionRetryMessage,
  createProgressMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createSyntheticUserCaveatMessage,
  createSystemAPIErrorMessage,
  createSystemMessage,
  createToolResultStopMessage,
  createToolUseSummaryMessage,
  createTurnDurationMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
  prepareUserContent,
} from './messages/messageCreation.js'

// Text extraction, wrapping, stream handler, types
export {
  extractTag,
  extractTextContent,
  getAssistantMessageText,
  getContentText,
  getUserMessageText,
  handleMessageFromStream,
  isEmptyMessageText,
  isNotEmptyMessage,
  type StreamingThinking,
  type StreamingToolUse,
  stripPromptXMLTags,
  textForResubmit,
  wrapCommandText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
} from './messages/messageContent.js'

// Tool use IDs, lookups, counts, types
export {
  buildMessageLookups,
  buildSubagentLookups,
  countToolCalls,
  EMPTY_LOOKUPS,
  EMPTY_STRING_SET,
  getLastAssistantMessage,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDs,
  getSiblingToolUseIDsFromLookup,
  getToolResultIDs,
  getToolUseID,
  getToolUseIDs,
  hasSuccessfulToolCall,
  hasToolCallsInLastAssistantTurn,
  hasUnresolvedHooks,
  hasUnresolvedHooksFromLookup,
  isSystemLocalCommandMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  type MessageLookups,
} from './messages/messageToolUse.js'

// Message reordering
export {
  reorderAttachmentsForAPI,
  reorderMessagesInUI,
} from './messages/messageOrdering.js'

// Normalization and merge functions
export {
  mergeAssistantMessages,
  mergeUserContentBlocks,
  mergeUserMessages,
  mergeUserMessagesAndToolResults,
  normalizeContentFromAPI,
  normalizeMessages,
} from './messages/messageNormalization.js'

// Filtering, stripping, validation
export {
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
  isThinkingMessage,
  shouldShowUserMessage,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripSignatureBlocks,
  stripToolReferenceBlocksFromUserMessage,
} from './messages/messageFiltering.js'

// API normalization (normalizeMessagesForAPI + ensureToolResultPairing)
export {
  ensureToolResultPairing,
  normalizeMessagesForAPI,
} from './messages/normalizeForAPI.js'

// Attachment normalization
export { normalizeAttachmentForAPI } from './messages/normalizeAttachment.js'
