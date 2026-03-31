/**
 * Session storage utilities for Claude Code.
 *
 * This barrel re-exports all session storage functionality from sub-modules
 * in utils/sessionStorage/.
 */

// Path resolution
export {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  MAX_TRANSCRIPT_READ_BYTES,
  setAgentTranscriptSubdir,
} from './sessionStorage/sessionPaths.js'

// Agent metadata CRUD
export {
  type AgentMetadata,
  deleteRemoteAgentMetadata,
  listRemoteAgentMetadata,
  readAgentMetadata,
  readRemoteAgentMetadata,
  type RemoteAgentMetadata,
  writeAgentMetadata,
  writeRemoteAgentMetadata,
} from './sessionStorage/agentMetadata.js'

// Shared types, type guards, utilities
export {
  getFirstMeaningfulUserMessageTextContent,
  getNodeEnv,
  getUserType,
  isChainParticipant,
  isCustomTitleEnabled,
  isEphemeralToolProgress,
  isTranscriptMessage,
  removeExtraFields,
  sessionIdExists,
} from './sessionStorage/sessionInternals.js'

// Project class, singleton, testing helpers
export {
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
} from './sessionStorage/project.js'

// Recording functions
export {
  adoptResumedSessionFile,
  flushSessionStorage,
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
  recordAttributionSnapshot,
  recordContentReplacement,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  removeTranscriptMessage,
  resetSessionFilePointer,
  type TeamInfo,
} from './sessionStorage/sessionRecording.js'

// Chain building and repair
export {
  buildConversationChain,
  checkResumeConsistency,
} from './sessionStorage/messageChain.js'

// Transcript file loading and parsing
export {
  clearSessionMessagesCache,
  doesMessageExistInSession,
  loadTranscriptFile,
  loadTranscriptFromFile,
} from './sessionStorage/transcriptFile.js'

// Session metadata save/restore/cache
export {
  cacheSessionTitle,
  clearSessionMetadata,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  getSessionIdFromLog,
  isLiteLog,
  linkSessionToPR,
  reAppendSessionMetadata,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveMode,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
} from './sessionStorage/sessionState.js'

// Session listing, enumeration, enrichment
export {
  enrichLogs,
  fetchLogs,
  getLastSessionLog,
  getSessionFilesLite,
  getSessionFilesWithMtime,
  loadAllLogsFromSessionFile,
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadFullLog,
  loadMessageLogs,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  searchSessionsByCustomTitle,
  type SessionLogResult,
} from './sessionStorage/sessionListing.js'

// Message cleaning, transform, agent extraction
export {
  cleanMessagesForLogging,
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  findUnresolvedToolUse,
  getAgentTranscript,
  getLogByIndex,
  isLoggableMessage,
  loadAllSubagentTranscriptsFromDisk,
  loadSubagentTranscripts,
} from './sessionStorage/messageTransform.js'
