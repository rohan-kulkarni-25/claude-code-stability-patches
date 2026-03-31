/**
 * CLI argument parsing and help for the bridge (remote-control) command.
 */

import { feature } from 'bun:bundle'
import { resolve } from 'path'
import { checkGate_CACHED_OR_BLOCKING } from '../services/analytics/growthbook.js'
import type { SpawnMode } from './types.js'

export const SPAWN_SESSIONS_DEFAULT = 32

/**
 * GrowthBook gate for multi-session spawn modes (--spawn / --capacity / --create-session-in-dir).
 * Sibling of tengu_ccr_bridge_multi_environment (multiple envs per host:dir) —
 * this one enables multiple sessions per environment.
 * Rollout staged via targeting rules: ants first, then gradual external.
 *
 * Uses the blocking gate check so a stale disk-cache miss doesn't unfairly
 * deny access. The fast path (cache has true) is still instant; only the
 * cold-start path awaits the server fetch, and that fetch also seeds the
 * disk cache for next time.
 */
export async function isMultiSessionSpawnEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge_multi_session')
}

export type ParsedArgs = {
  verbose: boolean
  sandbox: boolean
  debugFile?: string
  sessionTimeoutMs?: number
  permissionMode?: string
  name?: string
  /** Value passed to --spawn (if any); undefined if no --spawn flag was given. */
  spawnMode: SpawnMode | undefined
  /** Value passed to --capacity (if any); undefined if no --capacity flag was given. */
  capacity: number | undefined
  /** --[no-]create-session-in-dir override; undefined = use default (on). */
  createSessionInDir: boolean | undefined
  /** Resume an existing session instead of creating a new one. */
  sessionId?: string
  /** Resume the last session in this directory (reads bridge-pointer.json). */
  continueSession: boolean
  help: boolean
  error?: string
}

const SPAWN_FLAG_VALUES = ['session', 'same-dir', 'worktree'] as const

function parseSpawnValue(raw: string | undefined): SpawnMode | string {
  if (raw === 'session') return 'single-session'
  if (raw === 'same-dir') return 'same-dir'
  if (raw === 'worktree') return 'worktree'
  return `--spawn requires one of: ${SPAWN_FLAG_VALUES.join(', ')} (got: ${raw ?? '<missing>'})`
}

function parseCapacityValue(raw: string | undefined): number | string {
  const n = raw === undefined ? NaN : parseInt(raw, 10)
  if (isNaN(n) || n < 1) {
    return `--capacity requires a positive integer (got: ${raw ?? '<missing>'})`
  }
  return n
}

export function parseArgs(args: string[]): ParsedArgs {
  let verbose = false
  let sandbox = false
  let debugFile: string | undefined
  let sessionTimeoutMs: number | undefined
  let permissionMode: string | undefined
  let name: string | undefined
  let help = false
  let spawnMode: SpawnMode | undefined
  let capacity: number | undefined
  let createSessionInDir: boolean | undefined
  let sessionId: string | undefined
  let continueSession = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--sandbox') {
      sandbox = true
    } else if (arg === '--no-sandbox') {
      sandbox = false
    } else if (arg === '--debug-file' && i + 1 < args.length) {
      debugFile = resolve(args[++i]!)
    } else if (arg.startsWith('--debug-file=')) {
      debugFile = resolve(arg.slice('--debug-file='.length))
    } else if (arg === '--session-timeout' && i + 1 < args.length) {
      sessionTimeoutMs = parseInt(args[++i]!, 10) * 1000
    } else if (arg.startsWith('--session-timeout=')) {
      sessionTimeoutMs =
        parseInt(arg.slice('--session-timeout='.length), 10) * 1000
    } else if (arg === '--permission-mode' && i + 1 < args.length) {
      permissionMode = args[++i]!
    } else if (arg.startsWith('--permission-mode=')) {
      permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--name' && i + 1 < args.length) {
      name = args[++i]!
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    } else if (
      feature('KAIROS') &&
      arg === '--session-id' &&
      i + 1 < args.length
    ) {
      sessionId = args[++i]!
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') && arg.startsWith('--session-id=')) {
      sessionId = arg.slice('--session-id='.length)
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') && (arg === '--continue' || arg === '-c')) {
      continueSession = true
    } else if (arg === '--spawn' || arg.startsWith('--spawn=')) {
      if (spawnMode !== undefined) {
        return makeError('--spawn may only be specified once')
      }
      const raw = arg.startsWith('--spawn=')
        ? arg.slice('--spawn='.length)
        : args[++i]
      const v = parseSpawnValue(raw)
      if (v === 'single-session' || v === 'same-dir' || v === 'worktree') {
        spawnMode = v
      } else {
        return makeError(v)
      }
    } else if (arg === '--capacity' || arg.startsWith('--capacity=')) {
      if (capacity !== undefined) {
        return makeError('--capacity may only be specified once')
      }
      const raw = arg.startsWith('--capacity=')
        ? arg.slice('--capacity='.length)
        : args[++i]
      const v = parseCapacityValue(raw)
      if (typeof v === 'number') capacity = v
      else return makeError(v)
    } else if (arg === '--create-session-in-dir') {
      createSessionInDir = true
    } else if (arg === '--no-create-session-in-dir') {
      createSessionInDir = false
    } else {
      return makeError(
        `Unknown argument: ${arg}\nRun 'claude remote-control --help' for usage.`,
      )
    }
  }

  // Note: gate check for --spawn/--capacity/--create-session-in-dir is in bridgeMain
  // (gate-aware error). Flag cross-validation happens here.

  // --capacity only makes sense for multi-session modes.
  if (spawnMode === 'single-session' && capacity !== undefined) {
    return makeError(
      `--capacity cannot be used with --spawn=session (single-session mode has fixed capacity 1).`,
    )
  }

  // --session-id / --continue resume a specific session on its original
  // environment; incompatible with spawn-related flags (which configure
  // fresh session creation), and mutually exclusive with each other.
  if (
    (sessionId || continueSession) &&
    (spawnMode !== undefined ||
      capacity !== undefined ||
      createSessionInDir !== undefined)
  ) {
    return makeError(
      `--session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.`,
    )
  }
  if (sessionId && continueSession) {
    return makeError(`--session-id and --continue cannot be used together.`)
  }

  return {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode,
    capacity,
    createSessionInDir,
    sessionId,
    continueSession,
    help,
  }

  function makeError(error: string): ParsedArgs {
    return {
      verbose,
      sandbox,
      debugFile,
      sessionTimeoutMs,
      permissionMode,
      name,
      spawnMode,
      capacity,
      createSessionInDir,
      sessionId,
      continueSession,
      help,
      error,
    }
  }
}

export async function printHelp(): Promise<void> {
  // Use EXTERNAL_PERMISSION_MODES for help text — internal modes (bubble)
  // are ant-only and auto is feature-gated; they're still accepted by validation.
  const { EXTERNAL_PERMISSION_MODES } = await import('../types/permissions.js')
  const modes = EXTERNAL_PERMISSION_MODES.join(', ')
  const showServer = await isMultiSessionSpawnEnabled()
  const serverOptions = showServer
    ? `  --spawn <mode>                   Spawn mode: same-dir, worktree, session
                                   (default: same-dir)
  --capacity <N>                   Max concurrent sessions in worktree or
                                   same-dir mode (default: ${SPAWN_SESSIONS_DEFAULT})
  --[no-]create-session-in-dir     Pre-create a session in the current
                                   directory; in worktree mode this session
                                   stays in cwd while on-demand sessions get
                                   isolated worktrees (default: on)
`
    : ''
  const serverDescription = showServer
    ? `
  Remote Control runs as a persistent server that accepts multiple concurrent
  sessions in the current directory. One session is pre-created on start so
  you have somewhere to type immediately. Use --spawn=worktree to isolate
  each on-demand session in its own git worktree, or --spawn=session for
  the classic single-session mode (exits when that session ends). Press 'w'
  during runtime to toggle between same-dir and worktree.
`
    : ''
  const serverNote = showServer
    ? `  - Worktree mode requires a git repository or WorktreeCreate/WorktreeRemove hooks
`
    : ''
  const help = `
Remote Control - Connect your local environment to claude.ai/code

USAGE
  claude remote-control [options]
OPTIONS
  --name <name>                    Name for the session (shown in claude.ai/code)
${
  feature('KAIROS')
    ? `  -c, --continue                   Resume the last session in this directory
  --session-id <id>                Resume a specific session by ID (cannot be
                                   used with spawn flags or --continue)
`
    : ''
}  --permission-mode <mode>         Permission mode for spawned sessions
                                   (${modes})
  --debug-file <path>              Write debug logs to file
  -v, --verbose                    Enable verbose output
  -h, --help                       Show this help
${serverOptions}
DESCRIPTION
  Remote Control allows you to control sessions on your local device from
  claude.ai/code (https://claude.ai/code). Run this command in the
  directory you want to work in, then connect from the Claude app or web.
${serverDescription}
NOTES
  - You must be logged in with a Claude account that has a subscription
  - Run \`claude\` first in the directory to accept the workspace trust dialog
${serverNote}`
  // biome-ignore lint/suspicious/noConsole: intentional help output
  console.log(help)
}
