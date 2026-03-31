import { uniq } from '../array.js'
import type { Command } from '../../types/command.js'

// Track which skills have been sent to avoid re-sending. Keyed by agentId
// (empty string = main thread) so subagents get their own turn-0 listing —
// without per-agent scoping, the main thread populating this Set would cause
// every subagent's filterToBundledAndMcp result to dedup to empty.
const sentSkillNames = new Map<string, Set<string>>()

let suppressNext = false

// When skill-search is enabled and the filtered (bundled + MCP) listing exceeds
// this count, fall back to bundled-only. Protects MCP-heavy users (100+ servers)
// from truncation while keeping the turn-0 guarantee for typical setups.
const FILTERED_LISTING_MAX = 30

// Called when the skill set genuinely changes (plugin reload, skill file
// change on disk) so new skills get announced. NOT called on compact —
// post-compact re-injection costs ~4K tokens/event for marginal benefit.
export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
}

/**
 * Remove sent-skill tracking for a specific agent.
 * Called on task eviction to prevent unbounded growth.
 */
export function clearSentSkillNamesForAgent(agentKey: string): void {
  sentSkillNames.delete(agentKey)
}

/**
 * Suppress the next skill-listing injection. Called by conversationRecovery
 * on --resume when a skill_listing attachment already exists in the
 * transcript.
 *
 * `sentSkillNames` is module-scope — process-local. Each `claude -p` spawn
 * starts with an empty Map, so without this every resume re-injects the
 * full ~600-token listing even though it's already in the conversation from
 * the prior process. Shows up on every --resume; particularly loud for
 * daemons that respawn frequently.
 *
 * Trade-off: skills added between sessions won't be announced until the
 * next non-resume session. Acceptable — skill_listing was never meant to
 * cover cross-process deltas, and the agent can still call them (they're
 * in the Skill tool's runtime registry regardless).
 */
export function suppressNextSkillListing(): void {
  suppressNext = true
}

/**
 * Filter skills to bundled (Anthropic-curated) + MCP (user-connected) only.
 * Used when skill-search is enabled to resolve the turn-0 gap for subagents:
 * these sources are small, intent-signaled, and won't hit the truncation budget.
 * User/project/plugin skills (the long tail — 200+) go through discovery instead.
 *
 * Falls back to bundled-only if bundled+mcp exceeds FILTERED_LISTING_MAX.
 */
export function filterToBundledAndMcp(commands: Command[]): Command[] {
  const filtered = commands.filter(
    cmd => cmd.loadedFrom === 'bundled' || cmd.loadedFrom === 'mcp',
  )
  if (filtered.length > FILTERED_LISTING_MAX) {
    return filtered.filter(cmd => cmd.loadedFrom === 'bundled')
  }
  return filtered
}

export function extractAtMentionedFiles(content: string): string[] {
  // Extract filenames mentioned with @ symbol, including line range syntax: @file.txt#L10-20
  // Also supports quoted paths for files with spaces: @"my/file with spaces.txt"
  // Example: "foo bar @baz moo" would extract "baz"
  // Example: 'check @"my file.txt" please' would extract "my file.txt"

  // Two patterns: quoted paths and regular paths
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g

  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  // Extract quoted mentions first (skip agent mentions like @"code-reviewer (agent)")
  let match
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]) // The content inside quotes
    }
  }

  // Extract regular mentions
  const regularMatchArray = content.match(regularAtMentionRegex) || []
  regularMatchArray.forEach(match => {
    const filename = match.slice(match.indexOf('@') + 1)
    // Don't include if it starts with a quote (already handled as quoted)
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  // Combine and deduplicate
  return uniq([...quotedMatches, ...regularMatches])
}

export function extractMcpResourceMentions(content: string): string[] {
  // Extract MCP resources mentioned with @ symbol in format @server:uri
  // Example: "@server1:resource/path" would extract "server1:resource/path"
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g
  const matches = content.match(atMentionRegex) || []

  // Remove the prefix (everything before @) from each match
  return uniq(matches.map(match => match.slice(match.indexOf('@') + 1)))
}

export function extractAgentMentions(content: string): string[] {
  // Extract agent mentions in two formats:
  // 1. @agent-<agent-type> (legacy/manual typing)
  //    Example: "@agent-code-elegance-refiner" → "agent-code-elegance-refiner"
  // 2. @"<agent-type> (agent)" (from autocomplete selection)
  //    Example: '@"code-reviewer (agent)"' → "code-reviewer"
  // Supports colons, dots, and at-signs for plugin-scoped agents like "@agent-asana:project-status-updater"
  const results: string[] = []

  // Match quoted format: @"<type> (agent)"
  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
  let match
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2])
    }
  }

  // Match unquoted format: @agent-<type>
  const unquotedAgentRegex = /(^|\s)@(agent-[\w:.@-]+)/g
  const unquotedMatches = content.match(unquotedAgentRegex) || []
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1))
  }

  return uniq(results)
}

interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  // Parse mentions like "file.txt#L10-20", "file.txt#heading", or just "file.txt"
  // Supports line ranges (#L10, #L10-20) and strips non-line-range fragments (#heading)
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)

  if (!match) {
    return { filename: mention }
  }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart

  return { filename: filename ?? mention, lineStart, lineEnd }
}
