// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
  type ToolPermissionContext,
} from '../Tool.js'
import { expandPath } from './path.js'
import { count, uniq } from './array.js'
import { readdir, stat } from 'fs/promises'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import type { TodoList } from './todo/types.js'
import {
  type Task,
  listTasks,
  getTaskListId,
  isTodoV2Enabled,
} from './tasks.js'
import { getPlanFilePath, getPlan } from './plans.js'
import { getConnectedIdeName } from './ide.js'
import {
  filterInjectedMemoryFiles,
  getManagedAndUserConditionalRules,
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
  type MemoryFileInfo,
} from './claudemd.js'
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getViewedTeammateTask } from '../state/selectors.js'
import { logError } from './log.js'
import { logAntError } from './debug.js'
import { toError } from './errors.js'
import type { DiagnosticFile } from '../services/diagnosticTracking.js'
import { diagnosticTracker } from '../services/diagnosticTracking.js'
import type {
  AttachmentMessage,
  Message,
  MessageOrigin,
} from 'src/types/message.js'
import {
  type QueuedCommand,
  getImagePasteIds,
  isValidImagePaste,
} from 'src/types/textInputTypes.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import type {
  ContentBlockParam,
  ImageBlockParam,
  Base64ImageSource,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { maybeResizeAndDownsampleImageBlock } from './imageResizer.js'
import type { PastedContent } from './config.js'
import { getGlobalConfig } from './config.js'
import {
  getDefaultSonnetModel,
  getDefaultHaikuModel,
  getDefaultOpusModel,
} from './model/model.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { getSkillToolCommands, getMcpSkillCommands } from '../commands.js'
import type { Command } from '../types/command.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { formatCommandsWithinBudget } from '../tools/SkillTool/prompt.js'
import { getContextWindowForModel } from './context.js'
import type { DiscoverySignal } from '../services/skillSearch/signals.js'
// Conditional require for DCE. All skill-search string literals that would
// otherwise leak into external builds live inside these modules. The only
// surfaces in THIS file are: the maybe() call (gated via spread below) and
// the skill_listing suppression check (uses the same skillSearchModules null
// check). The type-only DiscoverySignal import above is erased at compile time.
/* eslint-disable @typescript-eslint/no-require-imports */
const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      featureCheck:
        require('../services/skillSearch/featureCheck.js') as typeof import('../services/skillSearch/featureCheck.js'),
      prefetch:
        require('../services/skillSearch/prefetch.js') as typeof import('../services/skillSearch/prefetch.js'),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createAbortController,
} from './abortController.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from './permissions/filesystem.js'
import {
  generateTaskAttachments,
  applyTaskOffsetsAndEvictions,
} from './task/framework.js'
import { getTaskOutputPath } from './task/diskOutput.js'
import type { TaskType, TaskStatus } from '../Task.js'
import {
  getOriginalCwd,
  getSessionId,
  getSdkBetas,
  getTotalCostUSD,
  getTotalOutputTokens,
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
} from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  checkForAsyncHookResponses,
  removeDeliveredAsyncHooks,
} from './hooks/AsyncHookRegistry.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../services/lsp/LSPDiagnosticRegistry.js'
import { logForDebugging } from './debug.js'
import {
  extractTextContent,
  getUserMessageText,
  isThinkingMessage,
} from './messages.js'
import { isHumanTurn } from './messagePredicates.js'
import { isEnvTruthy, getClaudeConfigHomeDir } from './envUtils.js'
import { feature } from 'bun:bundle'
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
/* eslint-enable @typescript-eslint/no-require-imports */
import { hasUltrathinkKeyword, isUltrathinkEnabled } from './thinking.js'
import {
  tokenCountFromLastAPIResponse,
} from './tokens.js'
import {
  getEffectiveContextWindowSize,
} from '../services/compact/autoCompact.js'
import {
  type InstructionsMemoryType,
} from './hooks.js'
import { jsonStringify } from './slowOperations.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import { findRelevantMemories } from '../memdir/findRelevantMemories.js'
import { memoryAge, memoryFreshnessText } from '../memdir/memoryAge.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../memdir/paths.js'
import { getAgentMemoryDir } from '../tools/AgentTool/agentMemory.js'
import {
  readUnreadMessages,
  markMessagesAsReadByPredicate,
  isShutdownApproved,
  isStructuredProtocolMessage,
  isIdleNotification,
} from './teammateMailbox.js'
import {
  getAgentName,
  getAgentId,
  getTeamName,
  isTeamLead,
} from './teammate.js'
import { isInProcessTeammate } from './teammateContext.js'
import { removeTeammateFromTeamFile } from './swarm/teamHelpers.js'
import { unassignTeammateTasks } from './tasks.js'
import { getCompanionIntroAttachment } from '../buddy/prompt.js'

// Types, configs, and constants are re-exported from ./attachments/types.js below.
// Sub-module imports for functions used by remaining orchestration code.
import {
  type Attachment,
  TODO_REMINDER_CONFIG,
  VERIFY_PLAN_REMINDER_CONFIG,
  RELEVANT_MEMORIES_CONFIG,
} from './attachments/types.js'
import {
  memoryFilesToAttachments,
  collectSurfacedMemories,
  readMemoriesForSurfacing,
  startRelevantMemoryPrefetch,
  collectRecentSuccessfulTools,
  filterDuplicateMemoryAttachments,
} from './attachments/memory.js'
import {
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  extractAgentMentions,
  parseAtMentionedFileLines,
  filterToBundledAndMcp,
} from './attachments/skills.js'
import {
  getDirectoriesToProcess,
  getChangedFiles,
  tryGetPDFReference,
  generateFileAttachment,
} from './attachments/files.js'
import {
  getAgentPendingMessageAttachments,
  getDateChangeAttachments,
  getDeferredToolsDeltaAttachment,
  getAgentListingDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
  createAttachmentMessage,
} from './attachments/system.js'
import {
  getVerifyPlanReminderTurnCount,
  getCompactionReminderAttachment,
  getContextEfficiencyAttachment,
} from './attachments/reminders.js'

// Barrel re-exports from sub-modules
export type {
  FileAttachment,
  CompactFileReferenceAttachment,
  PDFReferenceAttachment,
  AlreadyReadFileAttachment,
  AgentMentionAttachment,
  AsyncHookResponseAttachment,
  HookAttachment,
  HookPermissionDecisionAttachment,
  HookSystemMessageAttachment,
  HookCancelledAttachment,
  HookErrorDuringExecutionAttachment,
  HookSuccessAttachment,
  HookNonBlockingErrorAttachment,
  Attachment,
  TeammateMailboxAttachment,
  TeamContextAttachment,
  MemoryPrefetch,
} from './attachments/types.js'
export {
  TODO_REMINDER_CONFIG,
  PLAN_MODE_ATTACHMENT_CONFIG,
  AUTO_MODE_ATTACHMENT_CONFIG,
  RELEVANT_MEMORIES_CONFIG,
  VERIFY_PLAN_REMINDER_CONFIG,
} from './attachments/types.js'
export {
  memoryFilesToAttachments,
  collectSurfacedMemories,
  readMemoriesForSurfacing,
  memoryHeader,
  startRelevantMemoryPrefetch,
  collectRecentSuccessfulTools,
  filterDuplicateMemoryAttachments,
} from './attachments/memory.js'
export {
  resetSentSkillNames,
  clearSentSkillNamesForAgent,
  suppressNextSkillListing,
  filterToBundledAndMcp,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  extractAgentMentions,
  parseAtMentionedFileLines,
} from './attachments/skills.js'
export {
  getDirectoriesToProcess,
  getChangedFiles,
  tryGetPDFReference,
  generateFileAttachment,
} from './attachments/files.js'
export {
  getAgentPendingMessageAttachments,
  getDateChangeAttachments,
  getDeferredToolsDeltaAttachment,
  getAgentListingDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
  createAttachmentMessage,
} from './attachments/system.js'
export {
  getVerifyPlanReminderTurnCount,
  getCompactionReminderAttachment,
  getContextEfficiencyAttachment,
} from './attachments/reminders.js'

/**
 * This is janky
 * TODO: Generate attachments when we create messages
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]> {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS) ||
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  ) {
    // query.ts:removeFromQueue dequeues these unconditionally after
    // getAttachmentMessages runs — returning [] here silently drops them.
    // Coworker runs with --bare and depends on task-notification for
    // mid-tool-call notifications from Local*Task/Remote*Task.
    return getQueuedCommandAttachments(queuedCommands)
  }

  // This will slow down submissions
  // TODO: Compute attachments as the user types, not here (though we use this
  // function for slash command prompts too)
  const abortController = createAbortController()
  const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
  const context = { ...toolUseContext, abortController }

  const isMainThread = !toolUseContext.agentId

  // Attachments which are added in response to on user input
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () =>
          processAtMentionedFiles(input, context),
        ),
        maybe('mcp_resources', () =>
          processMcpResourceAttachments(input, context),
        ),
        maybe('agent_mentions', () =>
          Promise.resolve(
            processAgentMentions(
              input,
              toolUseContext.options.agentDefinitions.activeAgents,
            ),
          ),
        ),
        // Skill discovery on turn 0 (user input as signal). Inter-turn
        // discovery runs via startSkillDiscoveryPrefetch in query.ts,
        // gated on write-pivot detection — see skillSearch/prefetch.ts.
        // feature() here lets DCE drop the 'skill_discovery' string (and the
        // function it calls) from external builds.
        //
        // skipSkillDiscovery gates out the SKILL.md-expansion path
        // (getMessagesForPromptSlashCommand). When a skill is invoked, its
        // SKILL.md content is passed as `input` here to extract @-mentions —
        // but that content is NOT user intent and must not trigger discovery.
        // Without this gate, a 110KB SKILL.md fires ~3.3s of chunked AKI
        // queries on every skill invocation (session 13a9afae).
        ...(feature('EXPERIMENTAL_SKILL_SEARCH') &&
        skillSearchModules &&
        !options?.skipSkillDiscovery
          ? [
              maybe('skill_discovery', () =>
                skillSearchModules.prefetch.getTurnZeroSkillDiscovery(
                  input,
                  messages ?? [],
                  context,
                ),
              ),
            ]
          : []),
      ]
    : []

  // Process user input attachments first (includes @mentioned files)
  // This ensures files are added to nestedMemoryAttachmentTriggers before nested_memory processes them
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // Thread-safe attachments available in sub-agents
  // NOTE: These must be created AFTER userInputAttachments completes to ensure
  // nestedMemoryAttachmentTriggers is populated before getNestedMemoryAttachments runs
  const allThreadAttachments = [
    // queuedCommands is already agent-scoped by the drain gate in query.ts —
    // main thread gets agentId===undefined, subagents get their own agentId.
    // Must run for all threads or subagent notifications drain into the void
    // (removed from queue by removeFromQueue but never attached).
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)),
    maybe('date_change', () =>
      Promise.resolve(getDateChangeAttachments(messages)),
    ),
    maybe('ultrathink_effort', () =>
      Promise.resolve(getUltrathinkEffortAttachment(input)),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
          {
            callSite: isMainThread
              ? 'attachments_main'
              : 'attachments_subagent',
            querySource,
          },
        ),
      ),
    ),
    maybe('agent_listing_delta', () =>
      Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages)),
    ),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
        ),
      ),
    ),
    ...(feature('BUDDY')
      ? [
          maybe('companion_intro', () =>
            Promise.resolve(getCompanionIntroAttachment(messages)),
          ),
        ]
      : []),
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    // relevant_memories moved to async prefetch (startRelevantMemoryPrefetch)
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    // Inter-turn skill discovery now runs via startSkillDiscoveryPrefetch
    // (query.ts, concurrent with the main turn). The blocking call that
    // previously lived here was the assistant_turn signal — 97% of those
    // Haiku calls found nothing in prod. Prefetch + await-at-collection
    // replaces it; see src/services/skillSearch/prefetch.ts.
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    ...(feature('TRANSCRIPT_CLASSIFIER')
      ? [
          maybe('auto_mode', () =>
            getAutoModeAttachments(messages, toolUseContext),
          ),
          maybe('auto_mode_exit', () =>
            getAutoModeExitAttachment(toolUseContext),
          ),
        ]
      : []),
    maybe('todo_reminders', () =>
      isTodoV2Enabled()
        ? getTaskReminderAttachments(messages, toolUseContext)
        : getTodoReminderAttachments(messages, toolUseContext),
    ),
    ...(isAgentSwarmsEnabled()
      ? [
          // Skip teammate mailbox for the session_memory forked agent.
          // It shares AppState.teamContext with the leader, so isTeamLead resolves
          // true and it reads+marks-as-read the leader's DMs as ephemeral attachments,
          // silently stealing messages that should be delivered as permanent turns.
          ...(querySource === 'session_memory'
            ? []
            : [
                maybe('teammate_mailbox', async () =>
                  getTeammateMailboxAttachments(toolUseContext),
                ),
              ]),
          maybe('team_context', async () =>
            getTeamContextAttachment(messages ?? []),
          ),
        ]
      : []),
    maybe('agent_pending_messages', async () =>
      getAgentPendingMessageAttachments(toolUseContext),
    ),
    maybe('critical_system_reminder', () =>
      Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext)),
    ),
    ...(feature('COMPACTION_REMINDERS')
      ? [
          maybe('compaction_reminder', () =>
            Promise.resolve(
              getCompactionReminderAttachment(
                messages ?? [],
                toolUseContext.options.mainLoopModel,
              ),
            ),
          ),
        ]
      : []),
    ...(feature('HISTORY_SNIP')
      ? [
          maybe('context_efficiency', () =>
            Promise.resolve(getContextEfficiencyAttachment(messages ?? [])),
          ),
        ]
      : []),
  ]

  // Attachments which are semantically only for the main conversation or don't have concurrency-safe implementations
  const mainThreadAttachments = isMainThread
    ? [
        maybe('ide_selection', async () =>
          getSelectedLinesFromIDE(ideSelection, toolUseContext),
        ),
        maybe('ide_opened_file', async () =>
          getOpenedFileFromIDE(ideSelection, toolUseContext),
        ),
        maybe('output_style', async () =>
          Promise.resolve(getOutputStyleAttachment()),
        ),
        maybe('diagnostics', async () =>
          getDiagnosticAttachments(toolUseContext),
        ),
        maybe('lsp_diagnostics', async () =>
          getLSPDiagnosticAttachments(toolUseContext),
        ),
        maybe('unified_tasks', async () =>
          getUnifiedTaskAttachments(toolUseContext),
        ),
        maybe('async_hook_responses', async () =>
          getAsyncHookResponseAttachments(),
        ),
        maybe('token_usage', async () =>
          Promise.resolve(
            getTokenUsageAttachment(
              messages ?? [],
              toolUseContext.options.mainLoopModel,
            ),
          ),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(
            getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd),
          ),
        ),
        maybe('output_token_usage', async () =>
          Promise.resolve(getOutputTokenUsageAttachment()),
        ),
        maybe('verify_plan_reminder', async () =>
          getVerifyPlanReminderAttachment(messages, toolUseContext),
        ),
      ]
    : []

  // Process thread and main thread attachments in parallel (no dependencies between them)
  const [threadAttachmentResults, mainThreadAttachmentResults] =
    await Promise.all([
      Promise.all(allThreadAttachments),
      Promise.all(mainThreadAttachments),
    ])

  clearTimeout(timeoutId)
  // Defensive: a getter leaking [undefined] crashes .map(a => a.type) below.
  return [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
  ].filter(a => a !== undefined && a !== null)
}

async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  const startTime = Date.now()
  try {
    const result = await f()
    const duration = Date.now() - startTime
    // Log only 5% of events to reduce volume
    if (Math.random() < 0.05) {
      // jsonStringify(undefined) returns undefined, so .length would throw
      const attachmentSizeBytes = result
        .filter(a => a !== undefined && a !== null)
        .reduce((total, attachment) => {
          return total + jsonStringify(attachment).length
        }, 0)
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        attachment_size_bytes: attachmentSizeBytes,
        attachment_count: result.length,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    return result
  } catch (e) {
    const duration = Date.now() - startTime
    // Log only 5% of events to reduce volume
    if (Math.random() < 0.05) {
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        error: true,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    logError(e)
    // For Ant users, log the full error to help with debugging
    logAntError(`Attachment error in ${label}`, e)

    return []
  }
}

const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

export async function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): Promise<Attachment[]> {
  if (!queuedCommands) {
    return []
  }
  // Include both 'prompt' and 'task-notification' commands as attachments.
  // During proactive agentic loops, task-notification commands would otherwise
  // stay in the queue permanently (useQueueProcessor can't run while a query
  // is active), causing hasPendingNotifications() to return true and Sleep to
  // wake immediately with 0ms duration in an infinite loop.
  const filtered = queuedCommands.filter(_ =>
    INLINE_NOTIFICATION_MODES.has(_.mode),
  )
  return Promise.all(
    filtered.map(async _ => {
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // Build content block array with text + images so the model sees them
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks]
      }
      return {
        type: 'queued_command' as const,
        prompt,
        source_uuid: _.uuid,
        imagePasteIds: getImagePasteIds(_.pastedContents),
        commandMode: _.mode,
        origin: _.origin,
        isMeta: _.isMeta,
      }
    }),
  )
}

async function buildImageContentBlocks(
  pastedContents: Record<number, PastedContent> | undefined,
): Promise<ImageBlockParam[]> {
  if (!pastedContents) {
    return []
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste)
  if (imageContents.length === 0) {
    return []
  }
  const results = await Promise.all(
    imageContents.map(async img => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (img.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: img.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return resized.block
    }),
  )
  return results
}


// Plan mode and auto mode attachments — extracted to ./attachments/modeAttachments.ts
import {
  getAutoModeAttachments,
  getAutoModeExitAttachment,
  getPlanModeAttachments,
  getPlanModeExitAttachment,
  hasToolResultContent,
} from './attachments/modeAttachments.js'


/**
 * Detects when the local date has changed since the last turn (user coding
 * past midnight) and emits an attachment to notify the model.
 *
 */
function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  logEvent('tengu_ultrathink', {})
  return [{ type: 'ultrathink_effort', level: 'high' }]
}

function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  return [{ type: 'critical_system_reminder', content: reminder }]
}

function getOutputStyleAttachment(): Attachment[] {
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || 'default'

  // Only show for non-default styles
  if (outputStyle === 'default') {
    return []
  }

  return [
    {
      type: 'output_style',
      style: outputStyle,
    },
  ]
}

async function getSelectedLinesFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const ideName = getConnectedIdeName(toolUseContext.options.mcpClients)
  if (
    !ideName ||
    ideSelection?.lineStart === undefined ||
    !ideSelection.text ||
    !ideSelection.filePath
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  return [
    {
      type: 'selected_lines_in_ide',
      ideName,
      lineStart: ideSelection.lineStart,
      lineEnd: ideSelection.lineStart + ideSelection.lineCount - 1,
      filename: ideSelection.filePath,
      content: ideSelection.text,
      displayPath: relative(getCwd(), ideSelection.filePath),
    },
  ]
}

/**
 * Converts memory files to attachments, filtering out already-loaded files.
 *
 * @param memoryFiles The memory files to convert
 * @param toolUseContext The tool use context (for tracking loaded files)
 * @returns Array of nested memory attachments
 */
function isInstructionsMemoryType(
  type: MemoryFileInfo['type'],
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

/**
 * Loads nested memory files for a given file path and returns them as attachments.
 * This function performs directory traversal to find CLAUDE.md files and conditional rules
 * that apply to the target file path.
 *
 * Processing order (must be preserved):
 * 1. Managed/User conditional rules matching targetPath
 * 2. Nested directories (CWD → target): CLAUDE.md + unconditional + conditional rules
 * 3. CWD-level directories (root → CWD): conditional rules only
 *
 * @param filePath The file path to get nested memory files for
 * @param toolUseContext The tool use context
 * @param appState The app state containing tool permission context
 * @returns Array of nested memory attachments
 */
async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    // Early return if path is not in allowed working path
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    // Phase 1: Process Managed and User conditional rules
    const managedUserRules = await getManagedAndUserConditionalRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    // Phase 2: Get directories to process
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_paper_halyard',
      false,
    )

    // Phase 3: Process nested directories (CWD → target)
    // Each directory gets: CLAUDE.md + unconditional rules + conditional rules
    for (const dir of nestedDirs) {
      const memoryFiles = (
        await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths)
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
      )
    }

    // Phase 4: Process CWD-level directories (root → CWD)
    // Only conditional rules (unconditional rules are already loaded eagerly)
    for (const dir of cwdLevelDirs) {
      const conditionalRules = (
        await getConditionalRulesForCwdLevelDirectory(
          dir,
          filePath,
          processedPaths,
        )
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath),
      )
    }
  } catch (error) {
    logError(error)
  }

  return attachments
}

async function getOpenedFileFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!ideSelection?.filePath || ideSelection.text) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  // Get nested memory files
  const nestedMemoryAttachments = await getNestedMemoryAttachmentsForFile(
    ideSelection.filePath,
    toolUseContext,
    appState,
  )

  // Return nested memory attachments followed by the opened file attachment
  return [
    ...nestedMemoryAttachments,
    {
      type: 'opened_file_in_ide',
      filename: ideSelection.filePath,
    },
  ]
}

async function processAtMentionedFiles(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    files.map(async file => {
      try {
        const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(file)
        const absoluteFilename = expandPath(filename)

        if (
          isFileReadDenied(absoluteFilename, appState.toolPermissionContext)
        ) {
          return null
        }

        // Check if it's a directory
        try {
          const stats = await stat(absoluteFilename)
          if (stats.isDirectory()) {
            try {
              const entries = await readdir(absoluteFilename, {
                withFileTypes: true,
              })
              const MAX_DIR_ENTRIES = 1000
              const truncated = entries.length > MAX_DIR_ENTRIES
              const names = entries.slice(0, MAX_DIR_ENTRIES).map(e => e.name)
              if (truncated) {
                names.push(
                  `\u2026 and ${entries.length - MAX_DIR_ENTRIES} more entries`,
                )
              }
              const stdout = names.join('\n')
              logEvent('tengu_at_mention_extracting_directory_success', {})

              return {
                type: 'directory' as const,
                path: absoluteFilename,
                content: stdout,
                displayPath: relative(getCwd(), absoluteFilename),
              }
            } catch {
              return null
            }
          }
        } catch {
          // If stat fails, continue with file logic
        }

        return await generateFileAttachment(
          absoluteFilename,
          toolUseContext,
          'tengu_at_mention_extracting_filename_success',
          'tengu_at_mention_extracting_filename_error',
          'at-mention',
          {
            offset: lineStart,
            limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined,
          },
        )
      } catch {
        logEvent('tengu_at_mention_extracting_filename_error', {})
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}

function processAgentMentions(
  input: string,
  agents: AgentDefinition[],
): Attachment[] {
  const agentMentions = extractAgentMentions(input)
  if (agentMentions.length === 0) return []

  const results = agentMentions.map(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)

    if (!agentDef) {
      logEvent('tengu_at_mention_agent_not_found', {})
      return null
    }

    logEvent('tengu_at_mention_agent_success', {})

    return {
      type: 'agent_mention' as const,
      agentType: agentDef.agentType,
    }
  })

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  )
}

async function processMcpResourceAttachments(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input)
  if (resourceMentions.length === 0) return []

  const mcpClients = toolUseContext.options.mcpClients || []

  const results = await Promise.all(
    resourceMentions.map(async mention => {
      try {
        const [serverName, ...uriParts] = mention.split(':')
        const uri = uriParts.join(':') // Rejoin in case URI contains colons

        if (!serverName || !uri) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        // Find the MCP client
        const client = mcpClients.find(c => c.name === serverName)
        if (!client || client.type !== 'connected') {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        // Find the resource in available resources to get its metadata
        const serverResources =
          toolUseContext.options.mcpResources?.[serverName] || []
        const resourceInfo = serverResources.find(r => r.uri === uri)
        if (!resourceInfo) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        try {
          const result = await client.client.readResource({
            uri,
          })

          logEvent('tengu_at_mention_mcp_resource_success', {})

          return {
            type: 'mcp_resource' as const,
            server: serverName,
            uri,
            name: resourceInfo.name || uri,
            description: resourceInfo.description,
            content: result,
          }
        } catch (error) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          logError(error)
          return null
        }
      } catch {
        logEvent('tengu_at_mention_mcp_resource_error', {})
        return null
      }
    }),
  )

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  ) as Attachment[]
}

/**
 * Processes paths that need nested memory attachments and checks for nested CLAUDE.md files
 * Uses nestedMemoryAttachmentTriggers field from ToolUseContext
 */
async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Check triggers first — getAppState() waits for a React render cycle,
  // and the common case is an empty trigger set.
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []

  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()

  return attachments
}

// hasToolResultContent, isToolResultBlock, ToolResultBlock moved to ./attachments/modeAttachments.ts

/**
 * Processes skill directories that were discovered during file operations.
 * Uses dynamicSkillDirTriggers field from ToolUseContext
 */
async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  if (
    toolUseContext.dynamicSkillDirTriggers &&
    toolUseContext.dynamicSkillDirTriggers.size > 0
  ) {
    // Parallelize: readdir all skill dirs concurrently
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
        try {
          const entries = await readdir(skillDir, { withFileTypes: true })
          const candidates = entries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
          // Parallelize: stat all SKILL.md candidates concurrently
          const checked = await Promise.all(
            candidates.map(async name => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null // SKILL.md doesn't exist, skip this entry
              }
            }),
          )
          return {
            skillDir,
            skillNames: checked.filter((n): n is string => n !== null),
          }
        } catch {
          // Ignore errors reading skill directories (e.g., directory doesn't exist)
          return { skillDir, skillNames: [] }
        }
      }),
    )

    for (const { skillDir, skillNames } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir,
          skillNames,
          displayPath: relative(getCwd(), skillDir),
        })
      }
    }

    toolUseContext.dynamicSkillDirTriggers.clear()
  }

  return attachments
}

async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  // Skip skill listing for agents that don't have the Skill tool — they can't use skills directly.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))
  ) {
    return []
  }

  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(
    toolUseContext.getAppState().mcp.commands,
  )
  let allCommands =
    mcpSkills.length > 0
      ? uniqBy([...localCommands, ...mcpSkills], 'name')
      : localCommands

  // When skill search is active, filter to bundled + MCP instead of full
  // suppression. Resolves the turn-0 gap: main thread gets turn-0 discovery
  // via getTurnZeroSkillDiscovery (blocking), but subagents use the async
  // subagent_spawn signal (collected post-tools, visible turn 1). Bundled +
  // MCP are small and intent-signaled; user/project/plugin skills go through
  // discovery. feature() first for DCE — the property-access string leaks
  // otherwise even with ?. on null.
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    skillSearchModules?.featureCheck.isSkillSearchEnabled()
  ) {
    allCommands = filterToBundledAndMcp(allCommands)
  }

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  // Resume path: prior process already injected a listing; it's in the
  // transcript. Mark everything current as sent so only post-resume deltas
  // (skills loaded later via /reload-plugins etc) get announced.
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  // Find skills we haven't sent yet
  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))

  if (newSkills.length === 0) {
    return []
  }

  // If no skills have been sent yet, this is the initial batch
  const isInitial = sent.size === 0

  // Mark as sent
  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }

  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${sent.size} total sent)`,
  )

  // Format within budget using existing logic
  const contextWindowTokens = getContextWindowForModel(
    toolUseContext.options.mainLoopModel,
    getSdkBetas(),
  )
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)

  return [
    {
      type: 'skill_listing',
      content,
      skillCount: newSkills.length,
      isInitial,
    },
  ]
}

// getSkillDiscoveryAttachment moved to skillSearch/prefetch.ts as
// getTurnZeroSkillDiscovery — keeps the 'skill_discovery' string literal inside
// a feature-gated module so it doesn't leak into external builds.

async function getDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Diagnostics are only useful if the agent has the Bash tool to act on them
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  // Get new diagnostics from the tracker (IDE diagnostics via MCP)
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics()
  if (newDiagnostics.length === 0) {
    return []
  }

  return [
    {
      type: 'diagnostics',
      files: newDiagnostics,
      isNew: true,
    },
  ]
}

/**
 * Get LSP diagnostic attachments from passive LSP servers.
 * Follows the AsyncHookRegistry pattern for consistent async attachment delivery.
 */
async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // LSP diagnostics are only useful if the agent has the Bash tool to act on them
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')

  try {
    const diagnosticSets = checkForLSPDiagnostics()

    if (diagnosticSets.length === 0) {
      return []
    }

    logForDebugging(
      `LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`,
    )

    // Convert each diagnostic set to an attachment
    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true,
    }))

    // Clear delivered diagnostics from registry to prevent memory leak
    // Follows same pattern as removeDeliveredAsyncHooks
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
      logForDebugging(
        `LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`,
      )
    }

    logForDebugging(
      `LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`,
    )

    return attachments
  } catch (error) {
    const err = toError(error)
    logError(
      new Error(`Failed to get LSP diagnostic attachments: ${err.message}`),
    )
    // Return empty array to allow other attachments to proceed
    return []
  }
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  // TODO: Compute this upstream
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )

  if (attachments.length === 0) {
    return
  }

  logEvent('tengu_attachments', {
    attachment_types: attachments.map(
      _ => _.type,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let lastTodoWriteIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TodoWrite usage BEFORE incrementing counter
      // (we don't want to count the TodoWrite message itself as "1 turn since write")
      if (
        lastTodoWriteIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block => block.type === 'tool_use' && block.name === 'TodoWrite',
        )
      ) {
        lastTodoWriteIndex = i
      }

      // Count assistant turns before finding events
      if (lastTodoWriteIndex === -1) assistantTurnsSinceWrite++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'todo_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

async function getTodoReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Skip if TodoWrite tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TODO_WRITE_TOOL_NAME),
    )
  ) {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TodoWrite
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the
  // "you haven't used it in a while" nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
    getTodoReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const todoKey = toolUseContext.agentId ?? getSessionId()
    const appState = toolUseContext.getAppState()
    const todos = appState.todos[todoKey] ?? []
    return [
      {
        type: 'todo_reminder',
        content: todos,
        itemCount: todos.length,
      },
    ]
  }

  return []
}

function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  let lastTaskManagementIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTaskManagement = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TaskCreate or TaskUpdate usage BEFORE incrementing counter
      if (
        lastTaskManagementIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block =>
            block.type === 'tool_use' &&
            (block.name === TASK_CREATE_TOOL_NAME ||
              block.name === TASK_UPDATE_TOOL_NAME),
        )
      ) {
        lastTaskManagementIndex = i
      }

      // Count assistant turns before finding events
      if (lastTaskManagementIndex === -1) assistantTurnsSinceTaskManagement++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'task_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return []
  }

  // Skip for ant users
  if (process.env.USER_TYPE === 'ant') {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TaskUpdate
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if TaskUpdate tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TASK_UPDATE_TOOL_NAME),
    )
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } =
    getTaskReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const tasks = await listTasks(getTaskListId())
    return [
      {
        type: 'task_reminder',
        content: tasks,
        itemCount: tasks.length,
      },
    ]
  }

  return []
}

/**
 * Get attachments for all unified tasks using the Task framework.
 * Replaces the old getBackgroundShellAttachments, getBackgroundRemoteSessionAttachments,
 * and getAsyncAgentAttachments functions.
 */
async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)

  applyTaskOffsetsAndEvictions(
    toolUseContext.setAppState,
    updatedTaskOffsets,
    evictedTaskIds,
  )

  // Convert TaskAttachment to Attachment format
  return attachments.map(taskAttachment => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}

async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses()

  if (responses.length === 0) {
    return []
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${responses.length} responses`,
  )

  const attachments = responses.map(
    ({
      processId,
      response,
      hookName,
      hookEvent,
      toolName,
      pluginId,
      stdout,
      stderr,
      exitCode,
    }) => {
      logForDebugging(
        `Hooks: Creating attachment for ${processId} (${hookName}): ${jsonStringify(response)}`,
      )
      return {
        type: 'async_hook_response' as const,
        processId,
        hookName,
        hookEvent,
        toolName,
        response,
        stdout,
        stderr,
        exitCode,
      }
    },
  )

  // Remove delivered hooks from registry to prevent re-processing
  if (responses.length > 0) {
    const processIds = responses.map(r => r.processId)
    removeDeliveredAsyncHooks(processIds)
    logForDebugging(
      `Hooks: Removed ${processIds.length} delivered hooks from registry`,
    )
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${attachments.length} attachments`,
  )

  return attachments
}

/**
 * Get teammate mailbox attachments for agent swarm communication
 * Teammates are independent Claude Code sessions running in parallel (swarms),
 * not parent-child subagent relationships.
 *
 * This function checks two sources for messages:
 * 1. File-based mailbox (for messages that arrived between polls)
 * 2. AppState.inbox (for messages queued mid-turn by useInboxPoller)
 *
 * Messages from AppState.inbox are delivered mid-turn as attachments,
 * allowing teammates to receive messages without waiting for the turn to end.
 */
async function getTeammateMailboxAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) {
    return []
  }
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // Get AppState early to check for team lead status
  const appState = toolUseContext.getAppState()

  // Use agent name from helper (checks AsyncLocalStorage, then dynamicTeamContext)
  const envAgentName = getAgentName()

  // Get team name (checks AsyncLocalStorage, dynamicTeamContext, then AppState)
  const teamName = getTeamName(appState.teamContext)

  // Check if we're the team lead (uses shared logic from swarm utils)
  const teamLeadStatus = isTeamLead(appState.teamContext)

  // Check if viewing a teammate's transcript (for in-process teammates)
  const viewedTeammate = getViewedTeammateTask(appState)

  // Resolve agent name based on who we're VIEWING:
  // - If viewing a teammate, use THEIR name (to read from their mailbox)
  // - Otherwise use env var if set, or leader's name if we're the team lead
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext.leadAgentId
    // Look up the lead's name from agents map (not the UUID)
    agentName = appState.teamContext.teammates[leadAgentId]?.name || 'team-lead'
  }

  logForDebugging(
    `[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
  )

  // Only check inbox if running as an agent in a swarm or team lead
  if (!agentName) {
    logForDebugging(
      `[SwarmMailbox] Not checking inbox - not in a swarm or team lead`,
    )
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`,
  )

  // Check mailbox for unread messages (routes to in-process or file-based)
  // Filter out structured protocol messages (permission requests/responses, shutdown
  // messages, etc.) — these must be left unread for useInboxPoller to route to their
  // proper handlers (workerPermissions queue, sandbox queue, etc.). Without filtering,
  // attachment generation races with InboxPoller: whichever reads first marks all
  // messages as read, and if attachments wins, protocol messages get bundled as raw
  // LLM context text instead of being routed to their UI handlers.
  const allUnreadMessages = await readUnreadMessages(agentName, teamName)
  const unreadMessages = allUnreadMessages.filter(
    m => !isStructuredProtocolMessage(m.text),
  )
  logForDebugging(
    `[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`,
  )

  // Also check AppState.inbox for pending messages (queued mid-turn by useInboxPoller)
  // IMPORTANT: appState.inbox contains messages FROM teammates TO the leader.
  // Only show these when viewing the leader's transcript (not a teammate's).
  // When viewing a teammate, their messages come from the file-based mailbox above.
  // In-process teammates share AppState with the leader — appState.inbox contains
  // the LEADER's queued messages, not the teammate's. Skip it to prevent leakage
  // (including self-echo from broadcasts). Teammates receive messages exclusively
  // through their file-based mailbox + waitForNextPromptOrShutdown.
  // Note: viewedTeammate was already computed above for agentName resolution
  const pendingInboxMessages =
    viewedTeammate || isInProcessTeammate()
      ? [] // Viewing teammate or running as in-process teammate - don't show leader's inbox
      : appState.inbox.messages.filter(m => m.status === 'pending')
  logForDebugging(
    `[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`,
  )

  // Combine both sources of messages WITH DEDUPLICATION
  // The same message could exist in both file mailbox and AppState.inbox due to race conditions:
  // 1. getTeammateMailboxAttachments reads file -> finds message M
  // 2. InboxPoller reads same file -> queues M in AppState.inbox
  // 3. getTeammateMailboxAttachments reads AppState -> finds M again
  // We deduplicate using from+timestamp+text prefix as the key
  const seen = new Set<string>()
  let allMessages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }> = []

  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`
    if (!seen.has(key)) {
      seen.add(key)
      allMessages.push({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
        color: m.color,
        summary: m.summary,
      })
    }
  }

  // Collapse multiple idle notifications per agent — keep only the latest.
  // Single pass to parse, then filter without re-parsing.
  const idleAgentByIndex = new Map<number, string>()
  const latestIdleByAgent = new Map<string, number>()
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i]!.text)
    if (idle) {
      idleAgentByIndex.set(i, idle.from)
      latestIdleByAgent.set(idle.from, i)
    }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    const beforeCount = allMessages.length
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i)
      if (agent === undefined) return true
      return latestIdleByAgent.get(agent) === i
    })
    logForDebugging(
      `[SwarmMailbox] Collapsed ${beforeCount - allMessages.length} duplicate idle notification(s)`,
    )
  }

  if (allMessages.length === 0) {
    logForDebugging(`[SwarmMailbox] No messages to deliver, returning empty`)
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Returning ${allMessages.length} message(s) as attachment for "${agentName}" (${unreadMessages.length} from file, ${pendingInboxMessages.length} from AppState, after dedup)`,
  )

  // Build the attachment BEFORE marking messages as processed
  // This prevents message loss if any operation below fails
  const attachment: Attachment[] = [
    {
      type: 'teammate_mailbox',
      messages: allMessages,
    },
  ]

  // Mark only non-structured mailbox messages as read after attachment is built.
  // Structured protocol messages stay unread for useInboxPoller to handle.
  if (unreadMessages.length > 0) {
    await markMessagesAsReadByPredicate(
      agentName,
      m => !isStructuredProtocolMessage(m.text),
      teamName,
    )
    logForDebugging(
      `[MailboxBridge] marked ${unreadMessages.length} non-structured message(s) as read for agent="${agentName}" team="${teamName || 'default'}"`,
    )
  }

  // Process shutdown_approved messages - remove teammates from team file
  // This mirrors what useInboxPoller does in interactive mode (lines 546-606)
  // In -p mode, useInboxPoller doesn't run, so we must handle this here
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        const teammateToRemove = shutdownApproval.from
        logForDebugging(
          `[SwarmMailbox] Processing shutdown_approved from ${teammateToRemove}`,
        )

        // Find the teammate ID by name
        const teammateId = appState.teamContext?.teammates
          ? Object.entries(appState.teamContext.teammates).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]
          : undefined

        if (teammateId) {
          // Remove from team file
          removeTeammateFromTeamFile(teamName, {
            agentId: teammateId,
            name: teammateToRemove,
          })
          logForDebugging(
            `[SwarmMailbox] Removed ${teammateToRemove} from team file`,
          )

          // Unassign tasks owned by this teammate
          await unassignTeammateTasks(
            teamName,
            teammateId,
            teammateToRemove,
            'shutdown',
          )

          // Remove from teamContext in AppState
          toolUseContext.setAppState(prev => {
            if (!prev.teamContext?.teammates) return prev
            if (!(teammateId in prev.teamContext.teammates)) return prev
            const { [teammateId]: _, ...remainingTeammates } =
              prev.teamContext.teammates
            return {
              ...prev,
              teamContext: {
                ...prev.teamContext,
                teammates: remainingTeammates,
              },
            }
          })
        }
      }
    }
  }

  // Mark AppState inbox messages as processed LAST, after attachment is built
  // This ensures messages aren't lost if earlier operations fail
  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map(m => m.id))
    toolUseContext.setAppState(prev => ({
      ...prev,
      inbox: {
        messages: prev.inbox.messages.map(m =>
          pendingIds.has(m.id) ? { ...m, status: 'processed' as const } : m,
        ),
      },
    }))
  }

  return attachment
}

/**
 * Get team context attachment for teammates in a swarm.
 * Only injected on the first turn to provide team coordination instructions.
 */
function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  // Only inject for teammates (not team lead or non-team sessions)
  if (!teamName || !agentId) {
    return []
  }

  // Only inject on first turn - check if there are no assistant messages yet
  const hasAssistantMessage = messages.some(m => m.type === 'assistant')
  if (hasAssistantMessage) {
    return []
  }

  const configDir = getClaudeConfigHomeDir()
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`
  const taskListPath = `${configDir}/tasks/${teamName}/`

  return [
    {
      type: 'team_context',
      agentId,
      agentName: agentName || agentId,
      teamName,
      teamConfigPath,
      taskListPath,
    },
  ]
}

function getTokenUsageAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return []
  }

  const contextWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountFromLastAPIResponse(messages)

  return [
    {
      type: 'token_usage',
      used: usedTokens,
      total: contextWindow,
      remaining: contextWindow - usedTokens,
    },
  ]
}

function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget === null || budget <= 0) {
      return []
    }
    return [
      {
        type: 'output_token_usage',
        turn: getTurnOutputTokens(),
        session: getTotalOutputTokens(),
        budget,
      },
    ]
  }
  return []
}

function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }

  const usedCost = getTotalCostUSD()
  const remainingBudget = maxBudgetUsd - usedCost

  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}

async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // Only remind if plan exists and verification not started or completed
  if (
    !pending ||
    pending.verificationStarted ||
    pending.verificationCompleted
  ) {
    return []
  }

  // Only remind every N turns
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (
      turnCount === 0 ||
      turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
    ) {
      return []
    }
  }

  return [{ type: 'verify_plan_reminder' }]
}


function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(
    filePath,
    toolPermissionContext,
    'read',
    'deny',
  )
  return denyRule !== null
}
