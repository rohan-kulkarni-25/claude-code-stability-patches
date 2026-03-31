import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
// Sync fs primitives for readFileTailSync — separate from fs/promises
// imports above. Named (not wildcard) per CLAUDE.md style; no collisions
// with the async-suffixed names.
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { dirname, join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { builtInCommandNames } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import {
  type AttributionSnapshotMessage,
  type Entry,
  type FileHistorySnapshotMessage,
  type LogOption,
  type SerializedMessage,
  type TranscriptMessage,
} from '../../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { getFsImplementation } from '../fsOperations.js'
import { extractTag } from '../messages.js'
import { LITE_READ_BUF_SIZE } from '../sessionStoragePortable.js'
import { jsonStringify } from '../slowOperations.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { getProjectDir } from './sessionPaths.js'

// Cache MACRO.VERSION at module level to work around bun --define bug in async contexts
// See: https://github.com/oven-sh/bun/issues/26168
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

export type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

// 50MB — prevents OOM in the tombstone slow path which reads + rewrites the
// entire session file. Session files can grow to multiple GB (inc-3930).
export const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

/**
 * Pre-compiled regex to skip non-meaningful messages when extracting first prompt.
 * Matches anything starting with a lowercase XML-like tag (IDE context, hook
 * output, task notifications, channel messages, etc.) or a synthetic interrupt
 * marker. Kept in sync with sessionStoragePortable.ts — generic pattern avoids
 * an ever-growing allowlist that falls behind as new notification types ship.
 */
export const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/**
 * Type guard to check if an entry is a transcript message.
 * Transcript messages include user, assistant, attachment, and system messages.
 * IMPORTANT: This is the single source of truth for what constitutes a transcript message.
 * loadTranscriptFile() uses this to determine which messages to load into the chain.
 *
 * Progress messages are NOT transcript messages. They are ephemeral UI state
 * and must not be persisted to the JSONL or participate in the parentUuid
 * chain. Including them caused chain forks that orphaned real conversation
 * messages on resume (see #14373, #23537).
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

/**
 * Entries that participate in the parentUuid chain. Used on the write path
 * (insertMessageChain, useLogMessages) to skip progress when assigning
 * parentUuid. Old transcripts with progress already in the chain are handled
 * by the progressBridge rewrite in loadTranscriptFile.
 */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

export type LegacyProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * Progress entries in transcripts written before PR #24099. They are not
 * in the Entry type union anymore but still exist on disk with uuid and
 * parentUuid fields. loadTranscriptFile bridges the chain across them.
 */
export function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

/**
 * High-frequency tool progress ticks (1/sec for Sleep, per-chunk for Bash).
 * These are UI-only: not sent to the API, not rendered after the tool
 * completes. Used by REPL.tsx to replace-in-place instead of appending, and
 * by loadTranscriptFile to skip legacy entries from old transcripts.
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
  ...(feature('PROACTIVE') || feature('KAIROS')
    ? (['sleep_progress'] as const)
    : []),
])
export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

// exported for testing
export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

// exported for testing
export function getUserType(): string {
  return process.env.USER_TYPE || 'external'
}

export function getEntrypoint(): string | undefined {
  return process.env.CLAUDE_CODE_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}

/**
 * Gets the last user message that was processed (i.e., before any non-user message appears).
 * Used to determine if a session has valid user interaction.
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) continue
    // Skip compact summary messages - they should not be treated as the first prompt
    if ('isCompactSummary' in msg && msg.isCompactSummary) continue

    const content = msg.message?.content
    if (!content) continue

    // Collect all text values. For array content (common in VS Code where
    // IDE metadata tags come before the user's actual prompt), iterate all
    // text blocks so we don't miss the real prompt hidden behind
    // <ide_selection>/<ide_opened_file> blocks.
    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) continue

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        // If it's a built-in command, then it's unlikely to provide
        // meaningful context (e.g. `/model sonnet`)
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // Otherwise, for custom commands, then keep it only if it has
          // arguments (e.g. `/review reticulate splines`)
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          // Return clean formatted command instead of raw XML
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // Format bash input with ! prefix (as user typed it). Checked before
      // the generic XML skip so bash-mode sessions get a meaningful title.
      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      // Skip non-meaningful messages (local command output, hook output,
      // autonomous tick prompts, task notifications, pure IDE metadata tags)
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(m => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    // Store a reasonably long version for display-time truncation
    // The actual truncation will be applied at display time based on terminal width
    if (result.length > 200) {
      result = result.slice(0, 200).trim() + '…'
    }

    return result
  }

  return 'No prompt'
}

/**
 * O(n) single-pass: find the message with the latest timestamp matching a predicate.
 * Replaces the `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` pattern
 * which is O(n log n) + 2n Date allocations.
 */
export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * Checks if a user message has visible content (text or image, not just tool_result).
 * Tool results are displayed as part of collapsed groups, not as standalone messages.
 * Also excludes meta messages which are not shown to the user.
 */
export function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') return false

  // Meta messages are not shown to the user
  if (message.isMeta) return false

  const content = message.message?.content
  if (!content) return false

  // String content is always visible
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  // Array content: check for text or image blocks (not tool_result)
  if (Array.isArray(content)) {
    return content.some(
      block =>
        block.type === 'text' ||
        block.type === 'image' ||
        block.type === 'document',
    )
  }

  return false
}

/**
 * Checks if an assistant message has visible text content (not just tool_use blocks).
 * Tool uses are displayed as grouped/collapsed UI elements, not as standalone messages.
 */
export function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') return false

  const content = message.message?.content
  if (!content || !Array.isArray(content)) return false

  // Check for text block (not just tool_use/thinking blocks)
  return content.some(
    block =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

/**
 * Counts visible messages that would appear as conversation turns in the UI.
 * Excludes:
 * - System, attachment, and progress messages
 * - User messages with isMeta flag (hidden from user)
 * - User messages that only contain tool_result blocks (displayed as collapsed groups)
 * - Assistant messages that only contain tool_use blocks (displayed as collapsed groups)
 */
export function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case 'user':
        // Count user messages with visible content (text, image, not just tool_result or meta)
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case 'assistant':
        // Count assistant messages with text content (not just tool_use)
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case 'attachment':
      case 'system':
      case 'progress':
        // These message types are not counted as visible conversation turns
        break
    }
  }
  return count
}

export function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  // Get the first user message for the prompt
  const firstPrompt = extractFirstPrompt(transcript)

  // Create timestamps from message timestamps
  const created = new Date(firstMessage.timestamp)
  const modified = new Date(lastMessage.timestamp)

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created,
    modified,
    firstPrompt,
    messageCount: countVisibleMessages(transcript),
    isSidechain: firstMessage.isSidechain,
    teamName: firstMessage.teamName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots: fileHistorySnapshots,
    attributionSnapshots: attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}

/**
 * Builds a filie history snapshot chain from the conversation
 */
export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → last index in snapshots[] for O(1) update lookup
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * Builds an attribution snapshot chain from the conversation.
 * Unlike file history snapshots, attribution snapshots are returned in full
 * because they use generated UUIDs (not message UUIDs) and represent
 * cumulative state that should be restored on session resume.
 */
export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // Return all attribution snapshots - they will be merged during restore
  return Array.from(attributionSnapshots.values())
}

/**
 * Append an entry to a session file. Creates the parent dir if missing.
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}

/**
 * Sync tail read for reAppendSessionMetadata's external-writer check.
 * fstat on the already-open fd (no extra path lookup); reads the same
 * LITE_READ_BUF_SIZE window that readLiteMetadata scans. Returns empty
 * string on any error so callers fall through to unconditional behavior.
 */
export function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync can throw; swallow to preserve return '' contract
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

export { VERSION }
