/**
 * Plugin cache management — path resolution, versioned cache layout,
 * seed probing, and plugin installation caching.
 * Extracted from pluginLoader.ts.
 */

import {
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from 'fs/promises'
import { basename, dirname, join, relative } from 'path'
import type {
  PluginManifest,
} from '../../../types/plugin.js'
import { logForDebugging } from '../../debug.js'
import {
  errorMessage,
  getErrnoPath,
  isENOENT,
  isFsInaccessible,
} from '../../errors.js'
import { pathExists } from '../../file.js'
import { getFsImplementation } from '../../fsOperations.js'
import { logError } from '../../log.js'
import { jsonParse, jsonStringify } from '../../slowOperations.js'
import { validatePathWithinBase } from '../pluginInstallationHelpers.js'
import { getPluginSeedDirs, getPluginsDirectory } from '../pluginDirectories.js'
import { parsePluginIdentifier } from '../pluginIdentifier.js'
import { calculatePluginVersion } from '../pluginVersioning.js'
import {
  PluginManifestSchema,
  type PluginMarketplaceEntry,
  type PluginSource,
} from '../schemas.js'
import {
  convertDirectoryToZipInPlace,
  extractZipToDirectory,
  getSessionPluginCachePath,
  isPluginZipCacheEnabled,
} from '../zipCache.js'
import {
  copyDir,
  installFromNpm,
  gitClone,
  installFromGit,
  installFromGitHub,
  installFromGitSubdir,
  installFromLocal,
} from '../pluginInstall.js'

/**
 * Get the path where plugin cache is stored
 */
export function getPluginCachePath(): string {
  return join(getPluginsDirectory(), 'cache')
}

/**
 * Compute the versioned cache path under a specific base plugins directory.
 * Used to probe both primary and seed caches.
 *
 * @param baseDir - Base plugins directory (e.g. getPluginsDirectory() or seed dir)
 * @param pluginId - Plugin identifier in format "name@marketplace"
 * @param version - Version string (semver, git SHA, etc.)
 * @returns Absolute path to versioned plugin directory under baseDir
 */
export function getVersionedCachePathIn(
  baseDir: string,
  pluginId: string,
  version: string,
): string {
  const { name: pluginName, marketplace } = parsePluginIdentifier(pluginId)
  const sanitizedMarketplace = (marketplace || 'unknown').replace(
    /[^a-zA-Z0-9\-_]/g,
    '-',
  )
  const sanitizedPlugin = (pluginName || pluginId).replace(
    /[^a-zA-Z0-9\-_]/g,
    '-',
  )
  // Sanitize version to prevent path traversal attacks
  const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
  return join(
    baseDir,
    'cache',
    sanitizedMarketplace,
    sanitizedPlugin,
    sanitizedVersion,
  )
}

/**
 * Get versioned cache path for a plugin under the primary plugins directory.
 * Format: ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
 *
 * @param pluginId - Plugin identifier in format "name@marketplace"
 * @param version - Version string (semver, git SHA, etc.)
 * @returns Absolute path to versioned plugin directory
 */
export function getVersionedCachePath(
  pluginId: string,
  version: string,
): string {
  return getVersionedCachePathIn(getPluginsDirectory(), pluginId, version)
}

/**
 * Get versioned ZIP cache path for a plugin.
 * This is the zip cache variant of getVersionedCachePath.
 */
export function getVersionedZipCachePath(
  pluginId: string,
  version: string,
): string {
  return `${getVersionedCachePath(pluginId, version)}.zip`
}

/**
 * Probe seed directories for a populated cache at this plugin version.
 * Seeds are checked in precedence order; first hit wins. Returns null if no
 * seed is configured or none contains a populated directory at this version.
 */
async function probeSeedCache(
  pluginId: string,
  version: string,
): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    const seedPath = getVersionedCachePathIn(seedDir, pluginId, version)
    try {
      const entries = await readdir(seedPath)
      if (entries.length > 0) return seedPath
    } catch {
      // Try next seed
    }
  }
  return null
}

/**
 * When the computed version is 'unknown', probe seed/cache/<m>/<p>/ for an
 * actual version dir. Handles the first-boot chicken-and-egg where the
 * version can only be known after cloning, but seed already has the clone.
 *
 * Per seed, only matches when exactly one version exists (typical BYOC case).
 * Multiple versions within a single seed → ambiguous → try next seed.
 * Seeds are checked in precedence order; first match wins.
 */
export async function probeSeedCacheAnyVersion(
  pluginId: string,
): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    // The parent of the version dir — computed the same way as
    // getVersionedCachePathIn, just without the version component.
    const pluginDir = dirname(getVersionedCachePathIn(seedDir, pluginId, '_'))
    try {
      const entries = await readdir(pluginDir)
      // Only match when exactly one version subdirectory exists.
      // Multiple versions → ambiguous → skip this seed.
      if (entries.length === 1) {
        const candidatePath = join(pluginDir, entries[0]!)
        const s = await stat(candidatePath)
        if (s.isDirectory()) {
          // Ensure it's not empty — an empty version dir is a failed partial install.
          const contents = await readdir(candidatePath)
          if (contents.length > 0) return candidatePath
        }
      }
    } catch {
      // Try next seed
    }
  }
  return null
}

/**
 * Get legacy (pre-versioning) cache path for a plugin.
 *
 * @param pluginName - Plugin name to compute path for
 * @returns Absolute path to legacy plugin directory
 */
export function getLegacyCachePath(pluginName: string): string {
  const cachePath = getPluginCachePath()
  return join(cachePath, pluginName.replace(/[^a-zA-Z0-9\-_]/g, '-'))
}

/**
 * Resolve plugin path with fallback to legacy location.
 *
 * Always:
 * 1. Try versioned path first if version is provided
 * 2. Fall back to legacy path for existing installations
 * 3. Return versioned path for new installations
 *
 * @param pluginId - Plugin identifier in format "name@marketplace"
 * @param version - Optional version string
 * @returns Absolute path to plugin directory
 */
export async function resolvePluginPath(
  pluginId: string,
  version?: string,
): Promise<string> {
  // Try versioned path first
  if (version) {
    const versionedPath = getVersionedCachePath(pluginId, version)
    if (await pathExists(versionedPath)) {
      return versionedPath
    }
  }

  // Fall back to legacy path for existing installations
  const pluginName = parsePluginIdentifier(pluginId).name || pluginId
  const legacyPath = getLegacyCachePath(pluginName)
  if (await pathExists(legacyPath)) {
    return legacyPath
  }

  // Return versioned path for new installations
  return version ? getVersionedCachePath(pluginId, version) : legacyPath
}

/**
 * Copy plugin files to versioned cache directory.
 *
 * For local plugins: Uses entry.source from marketplace.json as the single source of truth.
 * For remote plugins: Falls back to copying sourcePath (the downloaded content).
 *
 * @param sourcePath - Path to the plugin source (used as fallback for remote plugins)
 * @param pluginId - Plugin identifier in format "name@marketplace"
 * @param version - Version string for versioned path
 * @param entry - Optional marketplace entry containing the source field
 * @param marketplaceDir - Marketplace directory for resolving entry.source (undefined for remote plugins)
 * @returns Path to the cached plugin directory
 * @throws Error if the source directory is not found
 * @throws Error if the destination directory is empty after copy
 */
export async function copyPluginToVersionedCache(
  sourcePath: string,
  pluginId: string,
  version: string,
  entry?: PluginMarketplaceEntry,
  marketplaceDir?: string,
): Promise<string> {
  // When zip cache is enabled, the canonical format is a ZIP file
  const zipCacheMode = isPluginZipCacheEnabled()
  const cachePath = getVersionedCachePath(pluginId, version)
  const zipPath = getVersionedZipCachePath(pluginId, version)

  // If cache already exists (directory or ZIP), return it
  if (zipCacheMode) {
    if (await pathExists(zipPath)) {
      logForDebugging(
        `Plugin ${pluginId} version ${version} already cached at ${zipPath}`,
      )
      return zipPath
    }
  } else if (await pathExists(cachePath)) {
    const entries = await readdir(cachePath)
    if (entries.length > 0) {
      logForDebugging(
        `Plugin ${pluginId} version ${version} already cached at ${cachePath}`,
      )
      return cachePath
    }
    // Directory exists but is empty, remove it so we can recreate with content
    logForDebugging(
      `Removing empty cache directory for ${pluginId} at ${cachePath}`,
    )
    await rmdir(cachePath)
  }

  // Seed cache hit — return seed path in place (read-only, no copy).
  // Callers handle both directory and .zip paths; this returns a directory.
  const seedPath = await probeSeedCache(pluginId, version)
  if (seedPath) {
    logForDebugging(
      `Using seed cache for ${pluginId}@${version} at ${seedPath}`,
    )
    return seedPath
  }

  // Create parent directories
  await getFsImplementation().mkdir(dirname(cachePath))

  // For local plugins: copy entry.source directory (the single source of truth)
  // For remote plugins: marketplaceDir is undefined, fall back to copying sourcePath
  if (entry && typeof entry.source === 'string' && marketplaceDir) {
    const sourceDir = validatePathWithinBase(marketplaceDir, entry.source)

    logForDebugging(
      `Copying source directory ${entry.source} for plugin ${pluginId}`,
    )
    try {
      await copyDir(sourceDir, cachePath)
    } catch (e: unknown) {
      // Only remap ENOENT from the top-level sourceDir itself — nested ENOENTs
      // from recursive copyDir (broken symlinks, raced deletes) should preserve
      // their original path in the error.
      if (isENOENT(e) && getErrnoPath(e) === sourceDir) {
        throw new Error(
          `Plugin source directory not found: ${sourceDir} (from entry.source: ${entry.source})`,
        )
      }
      throw e
    }
  } else {
    // Fallback for remote plugins (already downloaded) or plugins without entry.source
    logForDebugging(
      `Copying plugin ${pluginId} to versioned cache (fallback to full copy)`,
    )
    await copyDir(sourcePath, cachePath)
  }

  // Remove .git directory from cache if present
  const gitPath = join(cachePath, '.git')
  await rm(gitPath, { recursive: true, force: true })

  // Validate that cache has content - if empty, throw so fallback can be used
  const cacheEntries = await readdir(cachePath)
  if (cacheEntries.length === 0) {
    throw new Error(
      `Failed to copy plugin ${pluginId} to versioned cache: destination is empty after copy`,
    )
  }

  // Zip cache mode: convert directory to ZIP and remove the directory
  if (zipCacheMode) {
    await convertDirectoryToZipInPlace(cachePath, zipPath)
    logForDebugging(
      `Successfully cached plugin ${pluginId} as ZIP at ${zipPath}`,
    )
    return zipPath
  }

  logForDebugging(`Successfully cached plugin ${pluginId} at ${cachePath}`)
  return cachePath
}

/**
 * Generate a temporary cache name for a plugin
 */
export function generateTemporaryCacheNameForPlugin(
  source: PluginSource,
): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)

  let prefix: string

  if (typeof source === 'string') {
    prefix = 'local'
  } else {
    switch (source.source) {
      case 'npm':
        prefix = 'npm'
        break
      case 'pip':
        prefix = 'pip'
        break
      case 'github':
        prefix = 'github'
        break
      case 'url':
        prefix = 'git'
        break
      case 'git-subdir':
        prefix = 'subdir'
        break
      default:
        prefix = 'unknown'
    }
  }

  return `temp_${prefix}_${timestamp}_${random}`
}

/**
 * Cache a plugin from an external source
 */
export async function cachePlugin(
  source: PluginSource,
  options?: {
    manifest?: PluginManifest
  },
): Promise<{ path: string; manifest: PluginManifest; gitCommitSha?: string }> {
  const cachePath = getPluginCachePath()

  await getFsImplementation().mkdir(cachePath)

  const tempName = generateTemporaryCacheNameForPlugin(source)
  const tempPath = join(cachePath, tempName)

  let shouldCleanup = false
  let gitCommitSha: string | undefined

  try {
    logForDebugging(
      `Caching plugin from source: ${jsonStringify(source)} to temporary path ${tempPath}`,
    )

    shouldCleanup = true

    if (typeof source === 'string') {
      await installFromLocal(source, tempPath)
    } else {
      switch (source.source) {
        case 'npm':
          await installFromNpm(source.package, tempPath, {
            registry: source.registry,
            version: source.version,
          })
          break
        case 'github':
          await installFromGitHub(source.repo, tempPath, source.ref, source.sha)
          break
        case 'url':
          await installFromGit(source.url, tempPath, source.ref, source.sha)
          break
        case 'git-subdir':
          gitCommitSha = await installFromGitSubdir(
            source.url,
            tempPath,
            source.path,
            source.ref,
            source.sha,
          )
          break
        case 'pip':
          throw new Error('Python package plugins are not yet supported')
        default:
          throw new Error(`Unsupported plugin source type`)
      }
    }
  } catch (error) {
    if (shouldCleanup && (await pathExists(tempPath))) {
      logForDebugging(`Cleaning up failed installation at ${tempPath}`)
      try {
        await rm(tempPath, { recursive: true, force: true })
      } catch (cleanupError) {
        logForDebugging(`Failed to clean up installation: ${cleanupError}`, {
          level: 'error',
        })
      }
    }
    throw error
  }

  const manifestPath = join(tempPath, '.claude-plugin', 'plugin.json')
  const legacyManifestPath = join(tempPath, 'plugin.json')
  let manifest: PluginManifest

  if (await pathExists(manifestPath)) {
    try {
      const content = await readFile(manifestPath, { encoding: 'utf-8' })
      const parsed = jsonParse(content)
      const result = PluginManifestSchema().safeParse(parsed)

      if (result.success) {
        manifest = result.data
      } else {
        // Manifest exists but is invalid - throw error
        const errors = result.error.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join(', ')

        logForDebugging(`Invalid manifest at ${manifestPath}: ${errors}`, {
          level: 'error',
        })

        throw new Error(
          `Plugin has an invalid manifest file at ${manifestPath}. Validation errors: ${errors}`,
        )
      }
    } catch (error) {
      // Check if this is a validation error we just threw
      if (
        error instanceof Error &&
        error.message.includes('invalid manifest file')
      ) {
        throw error
      }

      // JSON parse error
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to parse manifest at ${manifestPath}: ${errorMsg}`,
        {
          level: 'error',
        },
      )

      throw new Error(
        `Plugin has a corrupt manifest file at ${manifestPath}. JSON parse error: ${errorMsg}`,
      )
    }
  } else if (await pathExists(legacyManifestPath)) {
    try {
      const content = await readFile(legacyManifestPath, {
        encoding: 'utf-8',
      })
      const parsed = jsonParse(content)
      const result = PluginManifestSchema().safeParse(parsed)

      if (result.success) {
        manifest = result.data
      } else {
        // Manifest exists but is invalid - throw error
        const errors = result.error.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join(', ')

        logForDebugging(
          `Invalid legacy manifest at ${legacyManifestPath}: ${errors}`,
          { level: 'error' },
        )

        throw new Error(
          `Plugin has an invalid manifest file at ${legacyManifestPath}. Validation errors: ${errors}`,
        )
      }
    } catch (error) {
      // Check if this is a validation error we just threw
      if (
        error instanceof Error &&
        error.message.includes('invalid manifest file')
      ) {
        throw error
      }

      // JSON parse error
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to parse legacy manifest at ${legacyManifestPath}: ${errorMsg}`,
        {
          level: 'error',
        },
      )

      throw new Error(
        `Plugin has a corrupt manifest file at ${legacyManifestPath}. JSON parse error: ${errorMsg}`,
      )
    }
  } else {
    manifest = options?.manifest || {
      name: tempName,
      description: `Plugin cached from ${typeof source === 'string' ? source : source.source}`,
    }
  }

  const finalName = manifest.name.replace(/[^a-zA-Z0-9-_]/g, '-')
  const finalPath = join(cachePath, finalName)

  if (await pathExists(finalPath)) {
    logForDebugging(`Removing old cached version at ${finalPath}`)
    await rm(finalPath, { recursive: true, force: true })
  }

  await rename(tempPath, finalPath)

  logForDebugging(`Successfully cached plugin ${manifest.name} to ${finalPath}`)

  return {
    path: finalPath,
    manifest,
    ...(gitCommitSha && { gitCommitSha }),
  }
}
