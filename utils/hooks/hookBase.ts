/**
 * Base hook utilities: constants, trust checking, input creation, background execution.
 */
import type { ShellCommand } from '../ShellCommand.js'
import type { HookEvent } from '../../types/hooks.js'
import type { AsyncHookJSONOutput } from 'src/entrypoints/agentSdkTypes.js'
import {
  getSessionId,
  getIsNonInteractiveSession,
  getOriginalCwd,
  getMainThreadAgentType,
} from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../config.js'
import {
  getTranscriptPathForSession,
} from '../sessionStorage.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { registerPendingAsyncHook } from './AsyncHookRegistry.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { wrapInSystemReminder } from '../messages.js'
import { emitHookResponse } from './hookEvents.js'

export const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * SessionEnd hooks run during shutdown/clear and need a much tighter bound
 * than TOOL_HOOK_EXECUTION_TIMEOUT_MS. This value is used by callers as both
 * the per-hook default timeout AND the overall AbortSignal cap (hooks run in
 * parallel, so one value suffices). Overridable via env var for users whose
 * teardown scripts need more time.
 */
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500
export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

export function executeInBackground({
  processId,
  hookId,
  shellCommand,
  asyncResponse,
  hookEvent,
  hookName,
  command,
  asyncRewake,
  pluginId,
}: {
  processId: string
  hookId: string
  shellCommand: ShellCommand
  asyncResponse: AsyncHookJSONOutput
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  hookName: string
  command: string
  asyncRewake?: boolean
  pluginId?: string
}): boolean {
  if (asyncRewake) {
    void shellCommand.result.then(async result => {
      await new Promise(resolve => setImmediate(resolve))
      const stdout = await shellCommand.taskOutput.getStdout()
      const stderr = shellCommand.taskOutput.getStderr()
      shellCommand.cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode: result.code,
        outcome: result.code === 0 ? 'success' : 'error',
      })
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(
            `Stop hook blocking error from command "${hookName}": ${stderr || stdout}`,
          ),
          mode: 'task-notification',
        })
      }
    })
    return true
  }

  if (!shellCommand.background(processId)) {
    return false
  }

  registerPendingAsyncHook({
    processId,
    hookId,
    asyncResponse,
    hookEvent,
    hookName,
    command,
    shellCommand,
    pluginId,
  })

  return true
}

/**
 * Checks if a hook should be skipped due to lack of workspace trust.
 *
 * ALL hooks require workspace trust because they execute arbitrary commands from
 * .claude/settings.json. This is a defense-in-depth security measure.
 *
 * @returns true if hook should be skipped, false if it should execute
 */
export function shouldSkipHookDueToTrust(): boolean {
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/**
 * Creates the base hook input that's common to all hook types
 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}
