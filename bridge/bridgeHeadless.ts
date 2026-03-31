/**
 * Headless bridge (daemon worker) mode.
 *
 * Non-interactive entrypoint for the remoteControl daemon worker. Config comes
 * from daemon.json, auth via IPC, logs to stdout pipe.
 */

import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { errorMessage } from '../utils/errors.js'
import { createBridgeApiClient } from './bridgeApi.js'
import { createSessionSpawner } from './sessionRunner.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import {
  BRIDGE_LOGIN_ERROR,
  type BridgeConfig,
  type BridgeLogger,
} from './types.js'

/**
 * Thrown by runBridgeHeadless for configuration issues the supervisor should
 * NOT retry (trust not accepted, worktree unavailable, http-not-https). The
 * daemon worker catches this and exits with EXIT_CODE_PERMANENT so the
 * supervisor parks the worker instead of respawning it on backoff.
 */
export class BridgeHeadlessPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeHeadlessPermanentError'
  }
}

export type HeadlessBridgeOpts = {
  dir: string
  name?: string
  spawnMode: 'same-dir' | 'worktree'
  capacity: number
  permissionMode?: string
  sandbox: boolean
  sessionTimeoutMs?: number
  createSessionOnStart: boolean
  getAccessToken: () => string | undefined
  onAuth401: (failedToken: string) => Promise<boolean>
  log: (s: string) => void
}

/**
 * Non-interactive bridge entrypoint for the `remoteControl` daemon worker.
 *
 * Linear subset of bridgeMain(): no readline dialogs, no stdin key handlers,
 * no TUI, no process.exit(). Config comes from the caller (daemon.json), auth
 * comes via IPC (supervisor's AuthManager), logs go to the worker's stdout
 * pipe. Throws on fatal errors — the worker catches and maps permanent vs
 * transient to the right exit code.
 *
 * Resolves cleanly when `signal` aborts and the poll loop tears down.
 */
export async function runBridgeHeadless(
  opts: HeadlessBridgeOpts,
  signal: AbortSignal,
): Promise<void> {
  const { dir, log } = opts

  // Worker inherits the supervisor's CWD. chdir first so git utilities
  // (getBranch/getRemoteUrl) — which read from bootstrap CWD state set
  // below — resolve against the right repo.
  process.chdir(dir)
  const { setOriginalCwd, setCwdState } = await import('../bootstrap/state.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../utils/config.js'
  )
  enableConfigs()
  const { initSinks } = await import('../utils/sinks.js')
  initSinks()

  if (!checkHasTrustDialogAccepted()) {
    throw new BridgeHeadlessPermanentError(
      `Workspace not trusted: ${dir}. Run \`claude\` in that directory first to accept the trust dialog.`,
    )
  }

  if (!opts.getAccessToken()) {
    // Transient — supervisor's AuthManager may pick up a token on next cycle.
    throw new Error(BRIDGE_LOGIN_ERROR)
  }

  const { getBridgeBaseUrl } = await import('./bridgeConfig.js')
  const baseUrl = getBridgeBaseUrl()
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    throw new BridgeHeadlessPermanentError(
      'Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
  }
  const sessionIngressUrl =
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import(
    '../utils/git.js'
  )
  const { hasWorktreeCreateHook } = await import('../utils/hooks.js')

  if (opts.spawnMode === 'worktree') {
    const worktreeAvailable =
      hasWorktreeCreateHook() || findGitRoot(dir) !== null
    if (!worktreeAvailable) {
      throw new BridgeHeadlessPermanentError(
        `Worktree mode requires a git repository or WorktreeCreate hooks. Directory ${dir} has neither.`,
      )
    }
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const config: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: opts.capacity,
    spawnMode: opts.spawnMode,
    verbose: false,
    sandbox: opts.sandbox,
    bridgeId,
    workerType: 'claude_code',
    environmentId: randomUUID(),
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    sessionTimeoutMs: opts.sessionTimeoutMs,
  }

  const api = createBridgeApiClient({
    baseUrl,
    getAccessToken: opts.getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: log,
    onAuth401: opts.onAuth401,
    getTrustedDeviceToken,
  })

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    // Transient — let supervisor backoff-retry.
    throw new Error(`Bridge registration failed: ${errorMessage(err)}`)
  }

  // Import spawnScriptArgs and runBridgeLoop lazily to avoid circular
  // module-evaluation dependency (bridgeMain re-exports from this file).
  const { spawnScriptArgs, runBridgeLoop } = await import('./bridgeMain.js')

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose: false,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode,
    onDebug: log,
  })

  const logger = createHeadlessBridgeLogger(log)
  logger.printBanner(config, environmentId)

  let initialSessionId: string | undefined
  if (opts.createSessionOnStart) {
    const { createBridgeSession } = await import('./createSession.js')
    try {
      const sid = await createBridgeSession({
        environmentId,
        title: opts.name,
        events: [],
        gitRepoUrl,
        branch,
        signal,
        baseUrl,
        getAccessToken: opts.getAccessToken,
        permissionMode: opts.permissionMode,
      })
      if (sid) {
        initialSessionId = sid
        log(`created initial session ${sid}`)
      }
    } catch (err) {
      log(`session pre-creation failed (non-fatal): ${errorMessage(err)}`)
    }
  }

  await runBridgeLoop(
    config,
    environmentId,
    environmentSecret,
    api,
    spawner,
    logger,
    signal,
    undefined,
    initialSessionId,
    async () => opts.getAccessToken(),
  )
}

/** BridgeLogger adapter that routes everything to a single line-log fn. */
function createHeadlessBridgeLogger(log: (s: string) => void): BridgeLogger {
  const noop = (): void => {}
  return {
    printBanner: (cfg, envId) =>
      log(
        `registered environmentId=${envId} dir=${cfg.dir} spawnMode=${cfg.spawnMode} capacity=${cfg.maxSessions}`,
      ),
    logSessionStart: (id, _prompt) => log(`session start ${id}`),
    logSessionComplete: (id, ms) => log(`session complete ${id} (${ms}ms)`),
    logSessionFailed: (id, err) => log(`session failed ${id}: ${err}`),
    logStatus: log,
    logVerbose: log,
    logError: s => log(`error: ${s}`),
    logReconnected: ms => log(`reconnected after ${ms}ms`),
    addSession: (id, _url) => log(`session attached ${id}`),
    removeSession: id => log(`session detached ${id}`),
    updateIdleStatus: noop,
    updateReconnectingStatus: noop,
    updateSessionStatus: noop,
    updateSessionActivity: noop,
    updateSessionCount: noop,
    updateFailedStatus: noop,
    setSpawnModeDisplay: noop,
    setRepoInfo: noop,
    setDebugLogPath: noop,
    setAttached: noop,
    setSessionTitle: noop,
    clearStatus: noop,
    toggleQr: noop,
    refreshDisplay: noop,
  }
}
