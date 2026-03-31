/**
 * Hooks are user-defined shell commands that can be executed at various points
 * in Claude Code's lifecycle.
 *
 * This barrel re-exports all hook functionality from sub-modules in utils/hooks/.
 */

// Types and hasBlockingResult
export {
  type AggregatedHookResult,
  type ConfigChangeSource,
  type ElicitationHookResult,
  type ElicitationResponse,
  type ElicitationResultHookResult,
  hasBlockingResult,
  type HookBlockingError,
  type HookOutsideReplResult,
  type HookResult,
  type InstructionsLoadReason,
  type InstructionsMemoryType,
} from './hooks/hookTypes.js'

// Base utilities
export {
  createBaseHookInput,
  getSessionEndHookTimeoutMs,
  shouldSkipHookDueToTrust,
} from './hooks/hookBase.js'

// Message formatters
export {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getUserPromptSubmitHookBlockingMessage,
} from './hooks/hookMessages.js'

// Matching
export { getMatchingHooks } from './hooks/hookMatching.js'

// All executor functions
export {
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeFileChangedHooks,
  executeFileSuggestionCommand,
  executeInstructionsLoadedHooks,
  executeNotificationHooks,
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
  executePostCompactHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreCompactHooks,
  executePreToolHooks,
  executeSessionEndHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeStatusLineCommand,
  executeStopFailureHooks,
  executeStopHooks,
  executeSubagentStartHooks,
  executeTaskCompletedHooks,
  executeTaskCreatedHooks,
  executeTeammateIdleHooks,
  executeUserPromptSubmitHooks,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasInstructionsLoadedHook,
  hasWorktreeCreateHook,
} from './hooks/hookExecutors.js'
