import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  SystemMessage,
} from '../../types/message.js'
import type { HookAttachment } from '../attachments.js'
import { isHookAttachmentMessage } from './messageInternals.js'
import { isToolUseRequestMessage } from './messageToolUse.js'

type ToolUseRequestMessage = NormalizedAssistantMessage & {
  message: { content: [ToolUseBlock] }
}

// Re-order, to move result messages to be after their tool use messages
export function reorderMessagesInUI(
  messages: (
    | NormalizedUserMessage
    | NormalizedAssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[],
  syntheticStreamingToolUseMessages: NormalizedAssistantMessage[],
): (
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | SystemMessage
)[] {
  // Maps tool use ID to its related messages
  const toolUseGroups = new Map<
    string,
    {
      toolUse: ToolUseRequestMessage | null
      preHooks: AttachmentMessage[]
      toolResult: NormalizedUserMessage | null
      postHooks: AttachmentMessage[]
    }
  >()

  // First pass: group messages by tool use ID
  for (const message of messages) {
    // Handle tool use messages
    if (isToolUseRequestMessage(message)) {
      const toolUseID = message.message.content[0]?.id
      if (toolUseID) {
        if (!toolUseGroups.has(toolUseID)) {
          toolUseGroups.set(toolUseID, {
            toolUse: null,
            preHooks: [],
            toolResult: null,
            postHooks: [],
          })
        }
        toolUseGroups.get(toolUseID)!.toolUse = message
      }
      continue
    }

    // Handle pre-tool-use hooks
    if (
      isHookAttachmentMessage(message) &&
      message.attachment.hookEvent === 'PreToolUse'
    ) {
      const toolUseID = message.attachment.toolUseID
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.preHooks.push(message)
      continue
    }

    // Handle tool results
    if (
      message.type === 'user' &&
      message.message.content[0]?.type === 'tool_result'
    ) {
      const toolUseID = message.message.content[0].tool_use_id
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.toolResult = message
      continue
    }

    // Handle post-tool-use hooks
    if (
      isHookAttachmentMessage(message) &&
      message.attachment.hookEvent === 'PostToolUse'
    ) {
      const toolUseID = message.attachment.toolUseID
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.postHooks.push(message)
      continue
    }
  }

  // Second pass: reconstruct the message list in the correct order
  const result: (
    | NormalizedUserMessage
    | NormalizedAssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[] = []
  const processedToolUses = new Set<string>()

  for (const message of messages) {
    // Check if this is a tool use
    if (isToolUseRequestMessage(message)) {
      const toolUseID = message.message.content[0]?.id
      if (toolUseID && !processedToolUses.has(toolUseID)) {
        processedToolUses.add(toolUseID)
        const group = toolUseGroups.get(toolUseID)
        if (group && group.toolUse) {
          // Output in order: tool use, pre hooks, tool result, post hooks
          result.push(group.toolUse)
          result.push(...group.preHooks)
          if (group.toolResult) {
            result.push(group.toolResult)
          }
          result.push(...group.postHooks)
        }
      }
      continue
    }

    // Check if this message is part of a tool use group
    if (
      isHookAttachmentMessage(message) &&
      (message.attachment.hookEvent === 'PreToolUse' ||
        message.attachment.hookEvent === 'PostToolUse')
    ) {
      // Skip - already handled in tool use groups
      continue
    }

    if (
      message.type === 'user' &&
      message.message.content[0]?.type === 'tool_result'
    ) {
      // Skip - already handled in tool use groups
      continue
    }

    // Handle api error messages (only keep the last one)
    if (message.type === 'system' && message.subtype === 'api_error') {
      const last = result.at(-1)
      if (last?.type === 'system' && last.subtype === 'api_error') {
        result[result.length - 1] = message
      } else {
        result.push(message)
      }
      continue
    }

    // Add standalone messages
    result.push(message)
  }

  // Add synthetic streaming tool use messages
  for (const message of syntheticStreamingToolUseMessages) {
    result.push(message)
  }

  // Filter to keep only the last api error message
  const last = result.at(-1)
  return result.filter(
    _ => _.type !== 'system' || _.subtype !== 'api_error' || _ === last,
  )
}

/**
 * Reorders messages so that attachments bubble up until they hit either:
 * - A tool call result (user message with tool_result content)
 * - Any assistant message
 */
export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  // We build `result` backwards (push) and reverse once at the end — O(N).
  // Using unshift inside the loop would be O(N²).
  const result: Message[] = []
  // Attachments are pushed as we encounter them scanning bottom-up, so
  // this buffer holds them in reverse order (relative to the input array).
  const pendingAttachments: AttachmentMessage[] = []

  // Scan from the bottom up
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!

    if (message.type === 'attachment') {
      // Collect attachment to bubble up
      pendingAttachments.push(message)
    } else {
      // Check if this is a stopping point
      const isStoppingPoint =
        message.type === 'assistant' ||
        (message.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content[0]?.type === 'tool_result')

      if (isStoppingPoint && pendingAttachments.length > 0) {
        // Hit a stopping point — attachments stop here (go after the stopping point).
        // pendingAttachments is already reversed; after the final result.reverse()
        // they will appear in original order right after `message`.
        for (let j = 0; j < pendingAttachments.length; j++) {
          result.push(pendingAttachments[j]!)
        }
        result.push(message)
        pendingAttachments.length = 0
      } else {
        // Regular message
        result.push(message)
      }
    }
  }

  // Any remaining attachments bubble all the way to the top.
  for (let j = 0; j < pendingAttachments.length; j++) {
    result.push(pendingAttachments[j]!)
  }

  result.reverse()
  return result
}
