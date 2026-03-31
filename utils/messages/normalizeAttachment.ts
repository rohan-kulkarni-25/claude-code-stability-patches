import { feature } from 'bun:bundle'
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import { areExplorePlanAgentsEnabled } from 'src/tools/AgentTool/builtInAgents.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import {
  FILE_READ_TOOL_NAME,
  MAX_LINES_TO_READ,
} from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../tools/TaskOutputTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { companionIntroText } from '../../buddy/prompt.js'
import { OUTPUT_STYLE_CONFIG } from '../../constants/outputStyles.js'
import { DiagnosticTrackingService } from '../../services/diagnosticTracking.js'
import type { AnyObject } from '../../Tool.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
} from '../../tools/FileReadTool/FileReadTool.js'
import type {
  Attachment,
  HookAttachment,
} from '../attachments.js'
import { memoryHeader } from '../attachments.js'
import type { MessageOrigin, UserMessage } from '../../types/message.js'
import { type Tool } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { quote } from '../bash/shellQuote.js'
import { logAntError } from '../debug.js'
import { formatFileSize, formatNumber } from '../format.js'
import { jsonStringify } from '../slowOperations.js'
import { getCurrentProjectConfig } from '../config.js'
import { hasEmbeddedSearchTools } from '../embeddedTools.js'
import { logMCPDebug } from '../log.js'
import {
  getPewterLedgerVariant,
  getPlanModeV2AgentCount,
  getPlanModeV2ExploreAgentCount,
  isPlanModeInterviewPhaseEnabled,
} from '../planModeV2.js'
import { isTodoV2Enabled } from '../tasks.js'
import { createUserMessage } from './messageCreation.js'
import { wrapInSystemReminder, wrapMessagesInSystemReminder, wrapCommandText } from './messageContent.js'
import { PLAN_PHASE4_CONTROL } from './messageConstants.js'

// Lazy import to avoid circular dependency (teammateMailbox -> teammate -> ... -> messages)
function getTeammateMailbox(): typeof import('../teammateMailbox.js') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../teammateMailbox.js')
}

function getPlanModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
  isSubAgent?: boolean
  planFilePath: string
  planExists: boolean
}): UserMessage[] {
  if (attachment.isSubAgent) {
    return getPlanModeV2SubAgentInstructions(attachment)
  }
  if (attachment.reminderType === 'sparse') {
    return getPlanModeV2SparseInstructions(attachment)
  }
  return getPlanModeV2Instructions(attachment)
}

// --
// Plan file structure experiment arms.
// Each arm returns the full Phase 4 section so the surrounding template
// stays a flat string interpolation with no conditionals inline.

// PLAN_PHASE4_CONTROL imported from messageConstants.ts

const PLAN_PHASE4_TRIM = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- One-line **Context**: what is being changed and why
- Include only your recommended approach, not all alternatives
- List the paths of files to be modified
- Reference existing functions and utilities to reuse, with their file paths
- End with **Verification**: the single command to run to confirm the change works (no numbered test procedures)`

const PLAN_PHASE4_CUT = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Do NOT write a Context or Background section. The user just told you what they want.
- List the paths of files to be modified and what changes in each (one line per file)
- Reference existing functions and utilities to reuse, with their file paths
- End with **Verification**: the single command that confirms the change works
- Most good plans are under 40 lines. Prose is a sign you are padding.`

const PLAN_PHASE4_CAP = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Do NOT write a Context, Background, or Overview section. The user just told you what they want.
- Do NOT restate the user's request. Do NOT write prose paragraphs.
- List the paths of files to be modified and what changes in each (one bullet per file)
- Reference existing functions to reuse, with file:line
- End with the single verification command
- **Hard limit: 40 lines.** If the plan is longer, delete prose — not file paths.`

function getPlanPhase4Section(): string {
  const variant = getPewterLedgerVariant()
  switch (variant) {
    case 'trim':
      return PLAN_PHASE4_TRIM
    case 'cut':
      return PLAN_PHASE4_CUT
    case 'cap':
      return PLAN_PHASE4_CAP
    case null:
      return PLAN_PHASE4_CONTROL
    default:
      variant satisfies never
      return PLAN_PHASE4_CONTROL
  }
}

function getPlanModeV2Instructions(attachment: {
  isSubAgent?: boolean
  planFilePath?: string
  planExists?: boolean
}): UserMessage[] {
  if (attachment.isSubAgent) {
    return []
  }

  // When interview phase is enabled, use the iterative workflow.
  if (isPlanModeInterviewPhaseEnabled()) {
    return getPlanModeInterviewInstructions(attachment)
  }

  const agentCount = getPlanModeV2AgentCount()
  const exploreAgentCount = getPlanModeV2ExploreAgentCount()
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath}. You can read it and make incremental edits using the ${FileEditTool.name} tool.`
    : `No plan file exists yet. You should create your plan at ${attachment.planFilePath} using the ${FileWriteTool.name} tool.`

  const content = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${EXPLORE_AGENT.agentType} subagent type.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. **Launch up to ${exploreAgentCount} ${EXPLORE_AGENT.agentType} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${exploreAgentCount} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach.

Launch ${PLAN_AGENT.agentType} agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to ${agentCount} agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)
${
  agentCount > 1
    ? `- **Multiple agents**: Use up to ${agentCount} agents for complex tasks that benefit from different perspectives

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture
`
    : ''
}
In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user

${getPlanPhase4Section()}

### Phase 5: Call ${ExitPlanModeV2Tool.name}
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ${ExitPlanModeV2Tool.name} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${ExitPlanModeV2Tool.name}. Do not stop unless it's for these 2 reasons

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${ExitPlanModeV2Tool.name} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${ExitPlanModeV2Tool.name}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getReadOnlyToolNames(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools from the registry, so point at find/grep via
  // Bash instead.
  const tools = hasEmbeddedSearchTools()
    ? [FILE_READ_TOOL_NAME, '`find`', '`grep`']
    : [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]
  const { allowedTools } = getCurrentProjectConfig()
  // allowedTools is a tool-name allowlist. find/grep are shell commands, not
  // tool names, so the filter is only meaningful for the non-embedded branch.
  const filtered =
    allowedTools && allowedTools.length > 0 && !hasEmbeddedSearchTools()
      ? tools.filter(t => allowedTools.includes(t))
      : tools
  return filtered.join(', ')
}

/**
 * Iterative interview-based plan mode workflow.
 * Instead of forcing Explore/Plan agents, this workflow has the model:
 * 1. Read files and ask questions iteratively
 * 2. Build up the spec/plan file incrementally as understanding grows
 * 3. Use AskUserQuestion throughout to clarify and gather input
 */
function getPlanModeInterviewInstructions(attachment: {
  planFilePath?: string
  planExists?: boolean
}): UserMessage[] {
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath}. You can read it and make incremental edits using the ${FileEditTool.name} tool.`
    : `No plan file exists yet. You should create your plan at ${attachment.planFilePath} using the ${FileWriteTool.name} tool.`

  const content = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you can't make alone, and write your findings into the plan file as you go. The plan file (above) is the ONLY file you may edit — it starts as a rough skeleton and gradually becomes the final plan.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use ${getReadOnlyToolNames()} to read code. Look for existing functions, utilities, and patterns to reuse.${areExplorePlanAgentsEnabled() ? ` You can use the ${EXPLORE_AGENT.agentType} agent type to parallelize complex searches without filling your context, though for straightforward queries direct tools are simpler.` : ''}
2. **Update the plan file** — After each discovery, immediately capture what you learned. Don't wait until the end.
3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, use ${ASK_USER_QUESTION_TOOL_NAME}. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan (headers and rough notes) and ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together (use multi-question ${ASK_USER_QUESTION_TOOL_NAME} calls)
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none

### Plan File Structure
Your plan file should be divided into clear sections using markdown headers, based on the request. Fill out these sections as you go.
- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### When to Converge

Your plan is ready when you've addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes. Call ${ExitPlanModeV2Tool.name} when the plan is ready for approval.

### Ending Your Turn

Your turn should only end by either:
- Using ${ASK_USER_QUESTION_TOOL_NAME} to gather more information
- Calling ${ExitPlanModeV2Tool.name} when the plan is ready for approval

**Important:** Use ${ExitPlanModeV2Tool.name} to request plan approval. Do NOT ask about plan approval via text or AskUserQuestion.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getPlanModeV2SparseInstructions(attachment: {
  planFilePath: string
}): UserMessage[] {
  const workflowDescription = isPlanModeInterviewPhaseEnabled()
    ? 'Follow iterative workflow: explore codebase, interview user, write to plan incrementally.'
    : 'Follow 5-phase workflow.'

  const content = `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${attachment.planFilePath}). ${workflowDescription} End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${ExitPlanModeV2Tool.name} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getPlanModeV2SubAgentInstructions(attachment: {
  planFilePath: string
  planExists: boolean
}): UserMessage[] {
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath}. You can read it and make incremental edits using the ${FileEditTool.name} tool if you need to.`
    : `No plan file exists yet. You should create your plan at ${attachment.planFilePath} using the ${FileWriteTool.name} tool if you need to.`

  const content = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received (for example, to make edits). Instead, you should:

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.
Answer the user's query comprehensively, using the ${ASK_USER_QUESTION_TOOL_NAME} tool if you need to ask the user clarifying questions. If you do use the ${ASK_USER_QUESTION_TOOL_NAME}, make sure to ask all clarifying questions you need to fully understand the user's intent before proceeding.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getAutoModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
}): UserMessage[] {
  if (attachment.reminderType === 'sparse') {
    return getAutoModeSparseInstructions()
  }
  return getAutoModeFullInstructions()
}

function getAutoModeFullInstructions(): UserMessage[] {
  const content = `## Auto Mode Active

Auto mode is active. The user chose continuous, autonomous execution. You should:

1. **Execute immediately** — Start implementing right away. Make reasonable assumptions and proceed on low-risk work.
2. **Minimize interruptions** — Prefer making reasonable assumptions over asking questions for routine decisions.
3. **Prefer action over planning** — Do not enter plan mode unless the user explicitly asks. When in doubt, start coding.
4. **Expect course corrections** — The user may provide suggestions or course corrections at any point; treat those as normal input.
5. **Do not take overly destructive actions** — Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.
6. **Avoid data exfiltration** — Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets (e.g. credentials, internal documentation) unless the user has explicitly authorized both that specific secret and its destination.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getAutoModeSparseInstructions(): UserMessage[] {
  const content = `Auto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function normalizeAttachmentForAPI(
  attachment: Attachment,
): UserMessage[] {
  if (isAgentSwarmsEnabled()) {
    if (attachment.type === 'teammate_mailbox') {
      return [
        createUserMessage({
          content: getTeammateMailbox().formatTeammateMessages(
            attachment.messages,
          ),
          isMeta: true,
        }),
      ]
    }
    if (attachment.type === 'team_context') {
      return [
        createUserMessage({
          content: `<system-reminder>
# Team Coordination

You are a teammate in team "${attachment.teamName}".

**Your Identity:**
- Name: ${attachment.agentName}

**Team Resources:**
- Team config: ${attachment.teamConfigPath}
- Task list: ${attachment.taskListPath}

**Team Leader:** The team lead's name is "team-lead". Send updates and completion notifications to them.

Read the team config to discover your teammates' names. Check the task list periodically. Create new tasks when work should be divided. Mark tasks resolved when complete.

**IMPORTANT:** Always refer to teammates by their NAME (e.g., "team-lead", "analyzer", "researcher"), never by UUID. When messaging, use the name directly:

\`\`\`json
{
  "to": "team-lead",
  "message": "Your message here",
  "summary": "Brief 5-10 word preview"
}
\`\`\`
</system-reminder>`,
          isMeta: true,
        }),
      ]
    }
  }


  // skill_discovery handled here (not in the switch) so the 'skill_discovery'
  // string literal lives inside a feature()-guarded block. A case label can't
  // be gated, but this pattern can — same approach as teammate_mailbox above.
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
    if (attachment.type === 'skill_discovery') {
      if (attachment.skills.length === 0) return []
      const lines = attachment.skills.map(s => `- ${s.name}: ${s.description}`)
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            `Skills relevant to your task:\n\n${lines.join('\n')}\n\n` +
            `These skills encode project-specific conventions. ` +
            `Invoke via Skill("<name>") for complete instructions.`,
          isMeta: true,
        }),
      ])
    }
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- teammate_mailbox/team_context/skill_discovery/bagel_console handled above
  // biome-ignore lint/nursery/useExhaustiveSwitchCases: teammate_mailbox/team_context/max_turns_reached/skill_discovery/bagel_console handled above, can't add case for dead code elimination
  switch (attachment.type) {
    case 'directory': {
      return wrapMessagesInSystemReminder([
        createToolUseMessage(BashTool.name, {
          command: `ls ${quote([attachment.path])}`,
          description: `Lists files in ${attachment.path}`,
        }),
        createToolResultMessage(BashTool, {
          stdout: attachment.content,
          stderr: '',
          interrupted: false,
        }),
      ])
    }
    case 'edited_text_file':
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `Note: ${attachment.filename} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. Here are the relevant changes (shown with line numbers):\n${attachment.snippet}`,
          isMeta: true,
        }),
      ])
    case 'file': {
      const fileContent = attachment.content as FileReadToolOutput
      switch (fileContent.type) {
        case 'image': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
        case 'text': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
            ...(attachment.truncated
              ? [
                  createUserMessage({
                    content: `Note: The file ${attachment.filename} was too large and has been truncated to the first ${MAX_LINES_TO_READ} lines. Don't tell the user about this truncation. Use ${FileReadTool.name} to read more of the file if you need.`,
                    isMeta: true, // only claude will see this
                  }),
                ]
              : []),
          ])
        }
        case 'notebook': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
        case 'pdf': {
          // PDFs are handled via supplementalContent in the tool result
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
      }
      break
    }
    case 'compact_file_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `Note: ${attachment.filename} was read before the last conversation was summarized, but the contents are too large to include. Use ${FileReadTool.name} tool if you need to access it.`,
          isMeta: true,
        }),
      ])
    }
    case 'pdf_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            `PDF file: ${attachment.filename} (${attachment.pageCount} pages, ${formatFileSize(attachment.fileSize)}). ` +
            `This PDF is too large to read all at once. You MUST use the ${FILE_READ_TOOL_NAME} tool with the pages parameter ` +
            `to read specific page ranges (e.g., pages: "1-5"). Do NOT call ${FILE_READ_TOOL_NAME} without the pages parameter ` +
            `or it will fail. Start by reading the first few pages to understand the structure, then read more as needed. ` +
            `Maximum 20 pages per request.`,
          isMeta: true,
        }),
      ])
    }
    case 'selected_lines_in_ide': {
      const maxSelectionLength = 2000
      const content =
        attachment.content.length > maxSelectionLength
          ? attachment.content.substring(0, maxSelectionLength) +
            '\n... (truncated)'
          : attachment.content

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user selected the lines ${attachment.lineStart} to ${attachment.lineEnd} from ${attachment.filename}:\n${content}\n\nThis may or may not be related to the current task.`,
          isMeta: true,
        }),
      ])
    }
    case 'opened_file_in_ide': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user opened the file ${attachment.filename} in the IDE. This may or may not be related to the current task.`,
          isMeta: true,
        }),
      ])
    }
    case 'plan_file_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `A plan file exists from plan mode at: ${attachment.planFilePath}\n\nPlan contents:\n\n${attachment.planContent}\n\nIf this plan is relevant to the current work and not already complete, continue working on it.`,
          isMeta: true,
        }),
      ])
    }
    case 'invoked_skills': {
      if (attachment.skills.length === 0) {
        return []
      }

      const skillsContent = attachment.skills
        .map(
          skill =>
            `### Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`,
        )
        .join('\n\n---\n\n')

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The following skills were invoked in this session. Continue to follow these guidelines:\n\n${skillsContent}`,
          isMeta: true,
        }),
      ])
    }
    case 'todo_reminder': {
      const todoItems = attachment.content
        .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
        .join('\n')

      let message = `The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`
      if (todoItems.length > 0) {
        message += `\n\nHere are the existing contents of your todo list:\n\n[${todoItems}]`
      }

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: message,
          isMeta: true,
        }),
      ])
    }
    case 'task_reminder': {
      if (!isTodoV2Enabled()) {
        return []
      }
      const taskItems = attachment.content
        .map(task => `#${task.id}. [${task.status}] ${task.subject}`)
        .join('\n')

      let message = `The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using ${TASK_CREATE_TOOL_NAME} to add new tasks and ${TASK_UPDATE_TOOL_NAME} to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`
      if (taskItems.length > 0) {
        message += `\n\nHere are the existing tasks:\n\n${taskItems}`
      }

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: message,
          isMeta: true,
        }),
      ])
    }
    case 'nested_memory': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `Contents of ${attachment.content.path}:\n\n${attachment.content.content}`,
          isMeta: true,
        }),
      ])
    }
    case 'relevant_memories': {
      return wrapMessagesInSystemReminder(
        attachment.memories.map(m => {
          // Use the header stored at attachment-creation time so the
          // rendered bytes are stable across turns (prompt-cache hit).
          // Fall back to recomputing for resumed sessions that predate
          // the stored-header field.
          const header = m.header ?? memoryHeader(m.path, m.mtimeMs)
          return createUserMessage({
            content: `${header}\n\n${m.content}`,
            isMeta: true,
          })
        }),
      )
    }
    case 'dynamic_skill': {
      // Dynamic skills are informational for the UI only - the skills themselves
      // are loaded separately and available via the Skill tool
      return []
    }
    case 'skill_listing': {
      if (!attachment.content) {
        return []
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The following skills are available for use with the Skill tool:\n\n${attachment.content}`,
          isMeta: true,
        }),
      ])
    }
    case 'queued_command': {
      // Prefer explicit origin carried from the queue; fall back to commandMode
      // for task notifications (which predate origin).
      const origin: MessageOrigin | undefined =
        attachment.origin ??
        (attachment.commandMode === 'task-notification'
          ? { kind: 'task-notification' }
          : undefined)

      // Only hide from the transcript if the queued command was itself
      // system-generated. Human input drained mid-turn has no origin and no
      // QueuedCommand.isMeta — it should stay visible. Previously this
      // hardcoded isMeta:true, which hid user-typed messages in brief mode
      // (filterForBriefTool) and in normal mode (shouldShowUserMessage).
      const metaProp =
        origin !== undefined || attachment.isMeta
          ? ({ isMeta: true } as const)
          : {}

      if (Array.isArray(attachment.prompt)) {
        // Handle content blocks (may include images)
        const textContent = attachment.prompt
          .filter((block): block is TextBlockParam => block.type === 'text')
          .map(block => block.text)
          .join('\n')

        const imageBlocks = attachment.prompt.filter(
          block => block.type === 'image',
        )

        const content: ContentBlockParam[] = [
          {
            type: 'text',
            text: wrapCommandText(textContent, origin),
          },
          ...imageBlocks,
        ]

        return wrapMessagesInSystemReminder([
          createUserMessage({
            content,
            ...metaProp,
            origin,
            uuid: attachment.source_uuid,
          }),
        ])
      }

      // String prompt
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: wrapCommandText(String(attachment.prompt), origin),
          ...metaProp,
          origin,
          uuid: attachment.source_uuid,
        }),
      ])
    }
    case 'output_style': {
      const outputStyle =
        OUTPUT_STYLE_CONFIG[
          attachment.style as keyof typeof OUTPUT_STYLE_CONFIG
        ]
      if (!outputStyle) {
        return []
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `${outputStyle.name} output style is active. Remember to follow the specific guidelines for this style.`,
          isMeta: true,
        }),
      ])
    }
    case 'diagnostics': {
      if (attachment.files.length === 0) return []

      // Use the centralized diagnostic formatting
      const diagnosticSummary =
        DiagnosticTrackingService.formatDiagnosticsSummary(attachment.files)

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `<new-diagnostics>The following new diagnostic issues were detected:\n\n${diagnosticSummary}</new-diagnostics>`,
          isMeta: true,
        }),
      ])
    }
    case 'plan_mode': {
      return getPlanModeInstructions(attachment)
    }
    case 'plan_mode_reentry': {
      const content = `## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${attachment.planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${ExitPlanModeV2Tool.name}

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'plan_mode_exit': {
      const planReference = attachment.planExists
        ? ` The plan file is located at ${attachment.planFilePath} if you need to reference it.`
        : ''
      const content = `## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'auto_mode': {
      return getAutoModeInstructions(attachment)
    }
    case 'auto_mode_exit': {
      const content = `## Exited Auto Mode

You have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'critical_system_reminder': {
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.content, isMeta: true }),
      ])
    }
    case 'mcp_resource': {
      // Format the resource content similar to how file attachments work
      const content = attachment.content
      if (!content || !content.contents || content.contents.length === 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No content)</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }

      // Transform each content item using the MCP transform function
      const transformedBlocks: ContentBlockParam[] = []

      // Handle the resource contents - only process text content
      for (const item of content.contents) {
        if (item && typeof item === 'object') {
          if ('text' in item && typeof item.text === 'string') {
            transformedBlocks.push(
              {
                type: 'text',
                text: 'Full contents of resource:',
              },
              {
                type: 'text',
                text: item.text,
              },
              {
                type: 'text',
                text: 'Do NOT read this resource again unless you think it may have changed, since you already have the full contents.',
              },
            )
          } else if ('blob' in item) {
            // Skip binary content including images
            const mimeType =
              'mimeType' in item
                ? String(item.mimeType)
                : 'application/octet-stream'
            transformedBlocks.push({
              type: 'text',
              text: `[Binary content: ${mimeType}]`,
            })
          }
        }
      }

      // If we have any content blocks, return them as a message
      if (transformedBlocks.length > 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: transformedBlocks,
            isMeta: true,
          }),
        ])
      } else {
        logMCPDebug(
          attachment.server,
          `No displayable content found in MCP resource ${attachment.uri}.`,
        )
        // Fallback if no content could be transformed
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No displayable content)</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }
    }
    case 'agent_mention': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user has expressed a desire to invoke the agent "${attachment.agentType}". Please invoke the agent appropriately, passing in the required context to it. `,
          isMeta: true,
        }),
      ])
    }
    case 'task_status': {
      const displayStatus =
        attachment.status === 'killed' ? 'stopped' : attachment.status

      // For stopped tasks, keep it brief — the work was interrupted and
      // the raw transcript delta isn't useful context.
      if (attachment.status === 'killed') {
        return [
          createUserMessage({
            content: wrapInSystemReminder(
              `Task "${attachment.description}" (${attachment.taskId}) was stopped by the user.`,
            ),
            isMeta: true,
          }),
        ]
      }

      // For running tasks, warn against spawning a duplicate — this attachment
      // is only emitted post-compaction, where the original spawn message is gone.
      if (attachment.status === 'running') {
        const parts = [
          `Background agent "${attachment.description}" (${attachment.taskId}) is still running.`,
        ]
        if (attachment.deltaSummary) {
          parts.push(`Progress: ${attachment.deltaSummary}`)
        }
        if (attachment.outputFilePath) {
          parts.push(
            `Do NOT spawn a duplicate. You will be notified when it completes. You can read partial output at ${attachment.outputFilePath} or send it a message with ${SEND_MESSAGE_TOOL_NAME}.`,
          )
        } else {
          parts.push(
            `Do NOT spawn a duplicate. You will be notified when it completes. You can check its progress with the ${TASK_OUTPUT_TOOL_NAME} tool or send it a message with ${SEND_MESSAGE_TOOL_NAME}.`,
          )
        }
        return [
          createUserMessage({
            content: wrapInSystemReminder(parts.join(' ')),
            isMeta: true,
          }),
        ]
      }

      // For completed/failed tasks, include the full delta
      const messageParts: string[] = [
        `Task ${attachment.taskId}`,
        `(type: ${attachment.taskType})`,
        `(status: ${displayStatus})`,
        `(description: ${attachment.description})`,
      ]

      if (attachment.deltaSummary) {
        messageParts.push(`Delta: ${attachment.deltaSummary}`)
      }

      if (attachment.outputFilePath) {
        messageParts.push(
          `Read the output file to retrieve the result: ${attachment.outputFilePath}`,
        )
      } else {
        messageParts.push(
          `You can check its output using the ${TASK_OUTPUT_TOOL_NAME} tool.`,
        )
      }

      return [
        createUserMessage({
          content: wrapInSystemReminder(messageParts.join(' ')),
          isMeta: true,
        }),
      ]
    }
    case 'async_hook_response': {
      const response = attachment.response
      const messages: UserMessage[] = []

      // Handle systemMessage
      if (response.systemMessage) {
        messages.push(
          createUserMessage({
            content: response.systemMessage,
            isMeta: true,
          }),
        )
      }

      // Handle additionalContext
      if (
        response.hookSpecificOutput &&
        'additionalContext' in response.hookSpecificOutput &&
        response.hookSpecificOutput.additionalContext
      ) {
        messages.push(
          createUserMessage({
            content: response.hookSpecificOutput.additionalContext,
            isMeta: true,
          }),
        )
      }

      return wrapMessagesInSystemReminder(messages)
    }
    // Note: 'teammate_mailbox' and 'team_context' are handled BEFORE switch
    // to avoid case label strings leaking into compiled output
    case 'token_usage':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Token usage: ${attachment.used}/${attachment.total}; ${attachment.remaining} remaining`,
          ),
          isMeta: true,
        }),
      ]
    case 'budget_usd':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `USD budget: $${attachment.used}/$${attachment.total}; $${attachment.remaining} remaining`,
          ),
          isMeta: true,
        }),
      ]
    case 'output_token_usage': {
      const turnText =
        attachment.budget !== null
          ? `${formatNumber(attachment.turn)} / ${formatNumber(attachment.budget)}`
          : formatNumber(attachment.turn)
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Output tokens \u2014 turn: ${turnText} \u00b7 session: ${formatNumber(attachment.session)}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'hook_blocking_error':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook blocking error from command: "${attachment.blockingError.command}": ${attachment.blockingError.blockingError}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_success':
      if (
        attachment.hookEvent !== 'SessionStart' &&
        attachment.hookEvent !== 'UserPromptSubmit'
      ) {
        return []
      }
      if (attachment.content === '') {
        return []
      }
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook success: ${attachment.content}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_additional_context': {
      if (attachment.content.length === 0) {
        return []
      }
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook additional context: ${attachment.content.join('\n')}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'hook_stopped_continuation':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook stopped continuation: ${attachment.message}`,
          ),
          isMeta: true,
        }),
      ]
    case 'compaction_reminder': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            'Auto-compact is enabled. When the context window is nearly full, older messages will be automatically summarized so you can continue working seamlessly. There is no need to stop or rush \u2014 you have unlimited context through automatic compaction.',
          isMeta: true,
        }),
      ])
    }
    case 'context_efficiency': {
      if (feature('HISTORY_SNIP')) {
        const { SNIP_NUDGE_TEXT } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../services/compact/snipCompact.js') as typeof import('../../services/compact/snipCompact.js')
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: SNIP_NUDGE_TEXT,
            isMeta: true,
          }),
        ])
      }
      return []
    }
    case 'date_change': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The date has changed. Today's date is now ${attachment.newDate}. DO NOT mention this to the user explicitly because they are already aware.`,
          isMeta: true,
        }),
      ])
    }
    case 'ultrathink_effort': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user has requested reasoning effort level: ${attachment.level}. Apply this to the current turn.`,
          isMeta: true,
        }),
      ])
    }
    case 'deferred_tools_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        parts.push(
          `The following deferred tools are now available via ToolSearch:\n${attachment.addedLines.join('\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'agent_listing_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        const header = attachment.isInitial
          ? 'Available agent types for the Agent tool:'
          : 'New agent types are now available for the Agent tool:'
        parts.push(`${header}\n${attachment.addedLines.join('\n')}`)
      }
      if (attachment.removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map(t => `- ${t}`).join('\n')}`,
        )
      }
      if (attachment.isInitial && attachment.showConcurrencyNote) {
        parts.push(
          `Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'mcp_instructions_delta': {
      const parts: string[] = []
      if (attachment.addedBlocks.length > 0) {
        parts.push(
          `# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${attachment.addedBlocks.join('\n\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following MCP servers have disconnected. Their instructions above no longer apply:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'companion_intro': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: companionIntroText(attachment.name, attachment.species),
          isMeta: true,
        }),
      ])
    }
    case 'verify_plan_reminder': {
      // Dead code elimination: CLAUDE_CODE_VERIFY_PLAN='false' in external builds, so === 'true' check allows Bun to eliminate the string
      /* eslint-disable-next-line custom-rules/no-process-env-top-level */
      const toolName =
        process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
          ? 'VerifyPlanExecution'
          : ''
      const content = `You have completed implementing the plan. Please call the "${toolName}" tool directly (NOT the ${AGENT_TOOL_NAME} tool or an agent) to verify that all plan items were completed correctly.`
      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'already_read_file':
    case 'command_permissions':
    case 'edited_image_file':
    case 'hook_cancelled':
    case 'hook_error_during_execution':
    case 'hook_non_blocking_error':
    case 'hook_system_message':
    case 'structured_output':
    case 'hook_permission_decision':
      return []
  }

  // Handle legacy attachments that were removed
  // IMPORTANT: if you remove an attachment type from normalizeAttachmentForAPI, make sure
  // to add it here to avoid errors from old --resume'd sessions that might still have
  // these attachment types.
  const LEGACY_ATTACHMENT_TYPES = [
    'autocheckpointing',
    'background_task_status',
    'todo',
    'task_progress', // removed in PR #19337
    'ultramemory', // removed in PR #23596
  ]
  if (LEGACY_ATTACHMENT_TYPES.includes((attachment as { type: string }).type)) {
    return []
  }

  logAntError(
    'normalizeAttachmentForAPI',
    new Error(
      `Unknown attachment type: ${(attachment as { type: string }).type}`,
    ),
  )
  return []
}

function createToolResultMessage<Output>(
  tool: Tool<AnyObject, Output>,
  toolUseResult: Output,
): UserMessage {
  try {
    const result = tool.mapToolResultToToolResultBlockParam(toolUseResult, '1')

    // If the result contains image content blocks, preserve them as is
    if (
      Array.isArray(result.content) &&
      result.content.some(block => block.type === 'image')
    ) {
      return createUserMessage({
        content: result.content as ContentBlockParam[],
        isMeta: true,
      })
    }

    // For string content, use raw string — jsonStringify would escape \n→\\n,
    // wasting ~1 token per newline (a 2000-line @-file = ~1000 wasted tokens).
    // Keep jsonStringify for array/object content where structure matters.
    const contentStr =
      typeof result.content === 'string'
        ? result.content
        : jsonStringify(result.content)
    return createUserMessage({
      content: `Result of calling the ${tool.name} tool:\n${contentStr}`,
      isMeta: true,
    })
  } catch {
    return createUserMessage({
      content: `Result of calling the ${tool.name} tool: Error`,
      isMeta: true,
    })
  }
}

function createToolUseMessage(
  toolName: string,
  input: { [key: string]: string | number },
): UserMessage {
  return createUserMessage({
    content: `Called the ${toolName} tool with the following input: ${jsonStringify(input)}`,
    isMeta: true,
  })
}
