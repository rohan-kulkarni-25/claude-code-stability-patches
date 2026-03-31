import {
  copyFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { isENOENT } from '../errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { gitExe } from '../git.js'
import { checkGitAvailable } from './gitAvailability.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { getPluginsDirectory } from './pluginDirectories.js'
import { validatePathWithinBase } from './pluginInstallationHelpers.js'

export async function copyDir(src: string, dest: string): Promise<void> {
  await getFsImplementation().mkdir(dest)

  const entries = await readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(srcPath)

      // Resolve the symlink to get the actual target path
      // This prevents circular symlinks when src and dest overlap (e.g., via symlink chains)
      let resolvedTarget: string
      try {
        resolvedTarget = await realpath(srcPath)
      } catch {
        // Broken symlink - copy the raw link target as-is
        await symlink(linkTarget, destPath)
        continue
      }

      // Resolve the source directory to handle symlinked source dirs
      let resolvedSrc: string
      try {
        resolvedSrc = await realpath(src)
      } catch {
        resolvedSrc = src
      }

      // Check if target is within the source tree (using proper path prefix matching)
      const srcPrefix = resolvedSrc.endsWith(sep)
        ? resolvedSrc
        : resolvedSrc + sep
      if (
        resolvedTarget.startsWith(srcPrefix) ||
        resolvedTarget === resolvedSrc
      ) {
        // Target is within source tree - create relative symlink that preserves
        // the same structure in the destination
        const targetRelativeToSrc = relative(resolvedSrc, resolvedTarget)
        const destTargetPath = join(dest, targetRelativeToSrc)
        const relativeLinkPath = relative(dirname(destPath), destTargetPath)
        await symlink(relativeLinkPath, destPath)
      } else {
        // Target is outside source tree - use absolute resolved path
        await symlink(resolvedTarget, destPath)
      }
    }
  }
}

function validateGitUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'file:'].includes(parsed.protocol)) {
      if (!/^git@[a-zA-Z0-9.-]+:/.test(url)) {
        throw new Error(
          `Invalid git URL protocol: ${parsed.protocol}. Only HTTPS, HTTP, file:// and SSH (git@) URLs are supported.`,
        )
      }
    }
    return url
  } catch {
    if (/^git@[a-zA-Z0-9.-]+:/.test(url)) {
      return url
    }
    throw new Error(`Invalid git URL: ${url}`)
  }
}

/**
 * Install a plugin from npm using a global cache (exported for testing)
 */
export async function installFromNpm(
  packageName: string,
  targetPath: string,
  options: { registry?: string; version?: string } = {},
): Promise<void> {
  const npmCachePath = join(getPluginsDirectory(), 'npm-cache')

  await getFsImplementation().mkdir(npmCachePath)

  const packageSpec = options.version
    ? `${packageName}@${options.version}`
    : packageName
  const packagePath = join(npmCachePath, 'node_modules', packageName)
  const needsInstall = !(await pathExists(packagePath))

  if (needsInstall) {
    logForDebugging(`Installing npm package ${packageSpec} to cache`)
    const args = ['install', packageSpec, '--prefix', npmCachePath]
    if (options.registry) {
      args.push('--registry', options.registry)
    }

    const result = await execFileNoThrow('npm', args)

    if (result.code !== 0) {
      throw new Error(
        `Failed to install npm package ${packageSpec}: ${result.stderr}`,
      )
    }
  }

  await copyDir(packagePath, targetPath)
}

/**
 * Clone a git repository (exported for testing)
 *
 * @param gitUrl - The git URL to clone
 * @param targetPath - Where to clone the repository
 * @param ref - Optional branch or tag to checkout
 * @param sha - Optional specific commit SHA to checkout
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  // Use --recurse-submodules to initialize submodules
  // Always start with shallow clone for efficiency
  const args = [
    'clone',
    '--depth',
    '1',
    '--recurse-submodules',
    '--shallow-submodules',
  ]

  // Add --branch flag for specific ref (works for both branches and tags)
  if (ref) {
    args.push('--branch', ref)
  }

  // If sha is specified, use --no-checkout since we'll checkout the SHA separately
  if (sha) {
    args.push('--no-checkout')
  }

  args.push(gitUrl, targetPath)

  const cloneStarted = performance.now()
  const cloneResult = await execFileNoThrow(gitExe(), args)

  if (cloneResult.code !== 0) {
    logPluginFetch(
      'plugin_clone',
      gitUrl,
      'failure',
      performance.now() - cloneStarted,
      classifyFetchError(cloneResult.stderr),
    )
    throw new Error(`Failed to clone repository: ${cloneResult.stderr}`)
  }

  // If sha is specified, fetch and checkout that specific commit
  if (sha) {
    // Try shallow fetch of the specific SHA first (most efficient)
    const shallowFetchResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['fetch', '--depth', '1', 'origin', sha],
      { cwd: targetPath },
    )

    if (shallowFetchResult.code !== 0) {
      // Some servers don't support fetching arbitrary SHAs
      // Fall back to unshallow fetch to get full history
      logForDebugging(
        `Shallow fetch of SHA ${sha} failed, falling back to unshallow fetch`,
      )
      const unshallowResult = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', '--unshallow'],
        { cwd: targetPath },
      )

      if (unshallowResult.code !== 0) {
        logPluginFetch(
          'plugin_clone',
          gitUrl,
          'failure',
          performance.now() - cloneStarted,
          classifyFetchError(unshallowResult.stderr),
        )
        throw new Error(
          `Failed to fetch commit ${sha}: ${unshallowResult.stderr}`,
        )
      }
    }

    // Checkout the specific commit
    const checkoutResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['checkout', sha],
      { cwd: targetPath },
    )

    if (checkoutResult.code !== 0) {
      logPluginFetch(
        'plugin_clone',
        gitUrl,
        'failure',
        performance.now() - cloneStarted,
        classifyFetchError(checkoutResult.stderr),
      )
      throw new Error(
        `Failed to checkout commit ${sha}: ${checkoutResult.stderr}`,
      )
    }
  }

  // Fire success only after ALL network ops (clone + optional SHA fetch)
  // complete — same telemetry-scope discipline as mcpb and marketplace_url.
  logPluginFetch(
    'plugin_clone',
    gitUrl,
    'success',
    performance.now() - cloneStarted,
  )
}

/**
 * Install a plugin from a git URL
 */
export async function installFromGit(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  const safeUrl = validateGitUrl(gitUrl)
  await gitClone(safeUrl, targetPath, ref, sha)
  const refMessage = ref ? ` (ref: ${ref})` : ''
  logForDebugging(
    `Cloned repository from ${safeUrl}${refMessage} to ${targetPath}`,
  )
}

/**
 * Install a plugin from GitHub
 */
export async function installFromGitHub(
  repo: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+$/.test(repo)) {
    throw new Error(
      `Invalid GitHub repository format: ${repo}. Expected format: owner/repo`,
    )
  }
  // Use HTTPS for CCR (no SSH keys), SSH for normal CLI
  const gitUrl = isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
    ? `https://github.com/${repo}.git`
    : `git@github.com:${repo}.git`
  return installFromGit(gitUrl, targetPath, ref, sha)
}

/**
 * Resolve a git-subdir `url` field to a clonable git URL.
 * Accepts GitHub owner/repo shorthand (converted to ssh or https depending on
 * CLAUDE_CODE_REMOTE) or any URL that passes validateGitUrl (https, http,
 * file, git@ ssh).
 */
function resolveGitSubdirUrl(url: string): string {
  if (/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+$/.test(url)) {
    return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
      ? `https://github.com/${url}.git`
      : `git@github.com:${url}.git`
  }
  return validateGitUrl(url)
}

/**
 * Install a plugin from a subdirectory of a git repository (exported for
 * testing).
 *
 * Uses partial clone (--filter=tree:0) + sparse-checkout so only the tree
 * objects along the path and the blobs under it are downloaded. For large
 * monorepos this is dramatically cheaper than a full clone — the tree objects
 * for a million-file repo can be hundreds of MB, all avoided here.
 *
 * Sequence:
 * 1. clone --depth 1 --filter=tree:0 --no-checkout [--branch ref]
 * 2. sparse-checkout set --cone -- <path>
 * 3. If sha: fetch --depth 1 origin <sha> (fallback: --unshallow), then
 *    checkout <sha>. The partial-clone filter is stored in remote config so
 *    subsequent fetches respect it; --unshallow gets all commits but trees
 *    and blobs remain lazy.
 *    If no sha: checkout HEAD (points to ref if --branch was used).
 * 4. Move <cloneDir>/<path> to targetPath and discard the clone.
 *
 * The clone is ephemeral — it goes into a sibling temp directory and is
 * removed after the subdir is extracted. targetPath ends up containing only
 * the plugin files with no .git directory.
 */
export async function installFromGitSubdir(
  url: string,
  targetPath: string,
  subdirPath: string,
  ref?: string,
  sha?: string,
): Promise<string | undefined> {
  if (!(await checkGitAvailable())) {
    throw new Error(
      'git-subdir plugin source requires git to be installed and on PATH. ' +
        'Install git (version 2.25 or later for sparse-checkout cone mode) and try again.',
    )
  }

  const gitUrl = resolveGitSubdirUrl(url)
  // Clone into a sibling temp dir (same filesystem → rename works, no EXDEV).
  const cloneDir = `${targetPath}.clone`

  const cloneArgs = [
    'clone',
    '--depth',
    '1',
    '--filter=tree:0',
    '--no-checkout',
  ]
  if (ref) {
    cloneArgs.push('--branch', ref)
  }
  cloneArgs.push(gitUrl, cloneDir)

  const cloneResult = await execFileNoThrow(gitExe(), cloneArgs)
  if (cloneResult.code !== 0) {
    throw new Error(
      `Failed to clone repository for git-subdir source: ${cloneResult.stderr}`,
    )
  }

  try {
    const sparseResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', subdirPath],
      { cwd: cloneDir },
    )
    if (sparseResult.code !== 0) {
      throw new Error(
        `git sparse-checkout set failed (git >= 2.25 required for cone mode): ${sparseResult.stderr}`,
      )
    }

    // Capture the resolved commit SHA before discarding the clone. The
    // extracted subdir has no .git, so the caller can't rev-parse it later.
    // If the source specified a full 40-char sha we already know it; otherwise
    // read HEAD (which points to ref's tip after --branch, or the remote
    // default branch if no ref was given).
    let resolvedSha: string | undefined

    if (sha) {
      const fetchSha = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', '--depth', '1', 'origin', sha],
        { cwd: cloneDir },
      )
      if (fetchSha.code !== 0) {
        logForDebugging(
          `Shallow fetch of SHA ${sha} failed for git-subdir, falling back to unshallow fetch`,
        )
        const unshallow = await execFileNoThrowWithCwd(
          gitExe(),
          ['fetch', '--unshallow'],
          { cwd: cloneDir },
        )
        if (unshallow.code !== 0) {
          throw new Error(`Failed to fetch commit ${sha}: ${unshallow.stderr}`)
        }
      }
      const checkout = await execFileNoThrowWithCwd(
        gitExe(),
        ['checkout', sha],
        { cwd: cloneDir },
      )
      if (checkout.code !== 0) {
        throw new Error(`Failed to checkout commit ${sha}: ${checkout.stderr}`)
      }
      resolvedSha = sha
    } else {
      // checkout HEAD materializes the working tree (this is where blobs are
      // lazy-fetched — the slow, network-bound step). It doesn't move HEAD;
      // --branch at clone time already positioned it. rev-parse HEAD is a
      // purely read-only ref lookup (no index lock), so it runs safely in
      // parallel with checkout and we avoid waiting on the network for it.
      const [checkout, revParse] = await Promise.all([
        execFileNoThrowWithCwd(gitExe(), ['checkout', 'HEAD'], {
          cwd: cloneDir,
        }),
        execFileNoThrowWithCwd(gitExe(), ['rev-parse', 'HEAD'], {
          cwd: cloneDir,
        }),
      ])
      if (checkout.code !== 0) {
        throw new Error(
          `git checkout after sparse-checkout failed: ${checkout.stderr}`,
        )
      }
      if (revParse.code === 0) {
        resolvedSha = revParse.stdout.trim()
      }
    }

    // Path traversal guard: resolve+verify the subdir stays inside cloneDir
    // before moving it out. rename ENOENT is wrapped with a friendlier
    // message that references the source path, not internal temp dirs.
    const resolvedSubdir = validatePathWithinBase(cloneDir, subdirPath)
    try {
      await rename(resolvedSubdir, targetPath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        throw new Error(
          `Subdirectory '${subdirPath}' not found in repository ${gitUrl}${ref ? ` (ref: ${ref})` : ''}. ` +
            'Check that the path is correct and exists at the specified ref/sha.',
        )
      }
      throw e
    }

    const refMsg = ref ? ` ref=${ref}` : ''
    const shaMsg = resolvedSha ? ` sha=${resolvedSha}` : ''
    logForDebugging(
      `Extracted subdir ${subdirPath} from ${gitUrl}${refMsg}${shaMsg} to ${targetPath}`,
    )
    return resolvedSha
  } finally {
    await rm(cloneDir, { recursive: true, force: true })
  }
}

/**
 * Install a plugin from a local path
 */
export async function installFromLocal(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source path does not exist: ${sourcePath}`)
  }

  await copyDir(sourcePath, targetPath)

  const gitPath = join(targetPath, '.git')
  await rm(gitPath, { recursive: true, force: true })
}
