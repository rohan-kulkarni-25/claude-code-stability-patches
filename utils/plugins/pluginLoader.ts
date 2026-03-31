/**
 * Plugin Loader Module
 *
 * This module is responsible for discovering, loading, and validating Claude Code plugins
 * from various sources including marketplaces and git repositories.
 *
 * NPM packages are also supported but must be referenced through marketplaces - the marketplace
 * entry contains the NPM package information.
 *
 * Plugin Discovery Sources (in order of precedence):
 * 1. Marketplace-based plugins (plugin@marketplace format in settings)
 * 2. Session-only plugins (from --plugin-dir CLI flag or SDK plugins option)
 *
 * Plugin Directory Structure:
 * ```
 * my-plugin/
 * ├── plugin.json          # Optional manifest with metadata
 * ├── commands/            # Custom slash commands
 * │   ├── build.md
 * │   └── deploy.md
 * ├── agents/              # Custom AI agents
 * │   └── test-runner.md
 * └── hooks/               # Hook configurations
 *     └── hooks.json       # Hook definitions
 * ```
 *
 * The loader handles:
 * - Plugin manifest validation
 * - Hooks configuration loading and variable resolution
 * - Duplicate name detection
 * - Enable/disable state management
 * - Error collection and reporting
 */

import {
  readFile,
  rm,
  stat,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, join, relative, resolve } from 'path'
import { getInlinePlugins } from '../../bootstrap/state.js'
import {
  BUILTIN_MARKETPLACE_NAME,
  getBuiltinPlugins,
} from '../../plugins/builtinPlugins.js'
import type {
  LoadedPlugin,
  PluginComponent,
  PluginError,
  PluginLoadResult,
  PluginManifest,
} from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  errorMessage,
  isFsInaccessible,
  toError,
} from '../errors.js'
import { pathExists } from '../file.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import {
  clearPluginSettingsBase,
  getPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'
import { SettingsSchema } from '../settings/types.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getAddDirEnabledPlugins } from './addDirPluginSettings.js'
import { verifyAndDemote } from './dependencyResolver.js'
import { getInMemoryInstalledPlugins } from './installedPluginsManager.js'
import { getManagedPluginNames } from './managedPlugins.js'
import {
  formatSourceForDisplay,
  getBlockedMarketplaces,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from './marketplaceHelpers.js'
import {
  getMarketplaceCacheOnly,
  getPluginByIdCacheOnly,
  loadKnownMarketplacesConfigSafe,
} from './marketplaceManager.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { calculatePluginVersion } from './pluginVersioning.js'
import {
  type CommandMetadata,
  PluginHooksSchema,
  PluginIdSchema,
  PluginManifestSchema,
  type PluginMarketplaceEntry,
  type PluginSource,
} from './schemas.js'
import {
  extractZipToDirectory,
  getSessionPluginCachePath,
  isPluginZipCacheEnabled,
} from './zipCache.js'

// Cache management — extracted to sub-module
import {
  cachePlugin,
  copyPluginToVersionedCache,
  generateTemporaryCacheNameForPlugin,
  getPluginCachePath,
  getVersionedCachePath,
  getVersionedCachePathIn,
  getVersionedZipCachePath,
  probeSeedCacheAnyVersion,
  resolvePluginPath,
} from './pluginLoader/cacheManagement.js'

export {
  cachePlugin,
  copyPluginToVersionedCache,
  generateTemporaryCacheNameForPlugin,
  getPluginCachePath,
  getLegacyCachePath,
  getVersionedCachePath,
  getVersionedCachePathIn,
  getVersionedZipCachePath,
  probeSeedCacheAnyVersion,
  resolvePluginPath,
} from './pluginLoader/cacheManagement.js'

// Re-exports from pluginInstall (previously inline)
export {
  copyDir,
  installFromNpm,
  gitClone,
  installFromGitSubdir,
} from './pluginInstall.js'

/**
 * Loads and validates a plugin manifest from a JSON file.
 *
 * The manifest provides metadata about the plugin including name, version,
 * description, author, and other optional fields. If no manifest exists,
 * a minimal one is created to allow the plugin to function.
 *
 * Example plugin.json:
 * ```json
 * {
 *   "name": "code-assistant",
 *   "version": "1.2.0",
 *   "description": "AI-powered code assistance tools",
 *   "author": {
 *     "name": "John Doe",
 *     "email": "john@example.com"
 *   },
 *   "keywords": ["coding", "ai", "assistant"],
 *   "homepage": "https://example.com/code-assistant",
 *   "hooks": "./custom-hooks.json",
 *   "commands": ["./extra-commands/*.md"]
 * }
 * ```
 */

/**
 * Loads and validates a plugin manifest from a JSON file.
 *
 * The manifest provides metadata about the plugin including name, version,
 * description, author, and other optional fields. If no manifest exists,
 * a minimal one is created to allow the plugin to function.
 *
 * Unknown keys in the manifest are silently stripped (PluginManifestSchema
 * uses zod's default strip behavior, not .strict()). Type mismatches and
 * other validation errors still fail.
 *
 * Behavior:
 * - Missing file: Creates default with provided name and source
 * - Invalid JSON: Throws error with parse details
 * - Schema validation failure: Throws error with validation details
 *
 * @param manifestPath - Full path to the plugin.json file
 * @param pluginName - Name to use in default manifest (e.g., "my-plugin")
 * @param source - Source description for default manifest (e.g., "git:repo" or ".claude-plugin/name")
 * @returns A valid PluginManifest object (either loaded or default)
 * @throws Error if manifest exists but is invalid (corrupt JSON or schema validation failure)
 */
export async function loadPluginManifest(
  manifestPath: string,
  pluginName: string,
  source: string,
): Promise<PluginManifest> {
  // Check if manifest file exists
  // If not, create a minimal manifest to allow plugin to function
  if (!(await pathExists(manifestPath))) {
    // Return default manifest with provided name and source
    return {
      name: pluginName,
      description: `Plugin from ${source}`,
    }
  }

  try {
    // Read and parse the manifest JSON file
    const content = await readFile(manifestPath, { encoding: 'utf-8' })
    const parsedJson = jsonParse(content)

    // Validate against the PluginManifest schema
    const result = PluginManifestSchema().safeParse(parsedJson)

    if (result.success) {
      // Valid manifest - return the validated data
      return result.data
    }

    // Schema validation failed but JSON was valid
    const errors = result.error.issues
      .map(err =>
        err.path.length > 0
          ? `${err.path.join('.')}: ${err.message}`
          : err.message,
      )
      .join(', ')

    logForDebugging(
      `Plugin ${pluginName} has an invalid manifest file at ${manifestPath}. Validation errors: ${errors}`,
      { level: 'error' },
    )

    throw new Error(
      `Plugin ${pluginName} has an invalid manifest file at ${manifestPath}.\n\nValidation errors: ${errors}`,
    )
  } catch (error) {
    // Check if this is the error we just threw (validation error)
    if (
      error instanceof Error &&
      error.message.includes('invalid manifest file')
    ) {
      throw error
    }

    // JSON parsing failed or file read error
    const errorMsg = errorMessage(error)

    logForDebugging(
      `Plugin ${pluginName} has a corrupt manifest file at ${manifestPath}. Parse error: ${errorMsg}`,
      { level: 'error' },
    )

    throw new Error(
      `Plugin ${pluginName} has a corrupt manifest file at ${manifestPath}.\n\nJSON parse error: ${errorMsg}`,
    )
  }
}

/**
 * Loads and validates plugin hooks configuration from a JSON file.
 * IMPORTANT: Only call this when the hooks file is expected to exist.
 *
 * @param hooksConfigPath - Full path to the hooks.json file
 * @param pluginName - Plugin name for error messages
 * @returns Validated HooksSettings
 * @throws Error if file doesn't exist or is invalid
 */
async function loadPluginHooks(
  hooksConfigPath: string,
  pluginName: string,
): Promise<HooksSettings> {
  if (!(await pathExists(hooksConfigPath))) {
    throw new Error(
      `Hooks file not found at ${hooksConfigPath} for plugin ${pluginName}. If the manifest declares hooks, the file must exist.`,
    )
  }

  const content = await readFile(hooksConfigPath, { encoding: 'utf-8' })
  const rawHooksConfig = jsonParse(content)

  // The hooks.json file has a wrapper structure with description and hooks
  // Use PluginHooksSchema to validate and extract the hooks property
  const validatedPluginHooks = PluginHooksSchema().parse(rawHooksConfig)

  return validatedPluginHooks.hooks as HooksSettings
}

/**
 * Validate a list of plugin component relative paths by checking existence in parallel.
 *
 * This helper parallelizes the pathExists checks (the expensive async part) while
 * preserving deterministic error/log ordering by iterating results sequentially.
 *
 * Introduced to fix a perf regression from the sync→async fs migration: sequential
 * `for { await pathExists }` loops add ~1-5ms of event-loop overhead per iteration.
 * With many plugins × several component types, this compounds to hundreds of ms.
 *
 * @param relPaths - Relative paths from the manifest/marketplace entry to validate
 * @param pluginPath - Plugin root directory to resolve relative paths against
 * @param pluginName - Plugin name for error messages
 * @param source - Source identifier for PluginError records
 * @param component - Which component these paths belong to (for error records)
 * @param componentLabel - Human-readable label for log messages (e.g. "Agent", "Skill")
 * @param contextLabel - Where the path came from, for log messages
 *   (e.g. "specified in manifest but", "from marketplace entry")
 * @param errors - Error array to push path-not-found errors into (mutated)
 * @returns Array of full paths that exist on disk, in original order
 */
async function validatePluginPaths(
  relPaths: string[],
  pluginPath: string,
  pluginName: string,
  source: string,
  component: PluginComponent,
  componentLabel: string,
  contextLabel: string,
  errors: PluginError[],
): Promise<string[]> {
  // Parallelize the async pathExists checks
  const checks = await Promise.all(
    relPaths.map(async relPath => {
      const fullPath = join(pluginPath, relPath)
      return { relPath, fullPath, exists: await pathExists(fullPath) }
    }),
  )
  // Process results in original order to keep error/log ordering deterministic
  const validPaths: string[] = []
  for (const { relPath, fullPath, exists } of checks) {
    if (exists) {
      validPaths.push(fullPath)
    } else {
      logForDebugging(
        `${componentLabel} path ${relPath} ${contextLabel} not found at ${fullPath} for ${pluginName}`,
        { level: 'warn' },
      )
      logError(
        new Error(
          `Plugin component file not found: ${fullPath} for ${pluginName}`,
        ),
      )
      errors.push({
        type: 'path-not-found',
        source,
        plugin: pluginName,
        path: fullPath,
        component,
      })
    }
  }
  return validPaths
}

/**
 * Creates a LoadedPlugin object from a plugin directory path.
 *
 * This is the central function that assembles a complete plugin representation
 * by scanning the plugin directory structure and loading all components.
 * It handles both fully-featured plugins with manifests and minimal plugins
 * with just commands or agents directories.
 *
 * Directory structure it looks for:
 * ```
 * plugin-directory/
 * ├── plugin.json          # Optional: Plugin manifest
 * ├── commands/            # Optional: Custom slash commands
 * │   ├── build.md         # /build command
 * │   └── test.md          # /test command
 * ├── agents/              # Optional: Custom AI agents
 * │   ├── reviewer.md      # Code review agent
 * │   └── optimizer.md     # Performance optimization agent
 * └── hooks/               # Optional: Hook configurations
 *     └── hooks.json       # Hook definitions
 * ```
 *
 * Component detection:
 * - Manifest: Loaded from plugin.json if present, otherwise creates default
 * - Commands: Sets commandsPath if commands/ directory exists
 * - Agents: Sets agentsPath if agents/ directory exists
 * - Hooks: Loads from hooks/hooks.json if present
 *
 * The function is tolerant of missing components - a plugin can have
 * any combination of the above directories/files. Missing component files
 * are reported as errors but don't prevent plugin loading.
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @param source - Source identifier (e.g., "git:repo", ".claude-plugin/my-plugin")
 * @param enabled - Initial enabled state (may be overridden by settings)
 * @param fallbackName - Name to use if manifest doesn't specify one
 * @param strict - When true, adds errors for duplicate hook files (default: true)
 * @returns Object containing the LoadedPlugin and any errors encountered
 */
export async function createPluginFromPath(
  pluginPath: string,
  source: string,
  enabled: boolean,
  fallbackName: string,
  strict = true,
): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }> {
  const errors: PluginError[] = []

  // Step 1: Load or create the plugin manifest
  // This provides metadata about the plugin (name, version, etc.)
  const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json')
  const manifest = await loadPluginManifest(manifestPath, fallbackName, source)

  // Step 2: Create the base plugin object
  // Start with required fields from manifest and parameters
  const plugin: LoadedPlugin = {
    name: manifest.name, // Use name from manifest (or fallback)
    manifest, // Store full manifest for later use
    path: pluginPath, // Absolute path to plugin directory
    source, // Source identifier (e.g., "git:repo" or ".claude-plugin/name")
    repository: source, // For backward compatibility with Plugin Repository
    enabled, // Current enabled state
  }

  // Step 3: Auto-detect optional directories in parallel
  const [
    commandsDirExists,
    agentsDirExists,
    skillsDirExists,
    outputStylesDirExists,
  ] = await Promise.all([
    !manifest.commands ? pathExists(join(pluginPath, 'commands')) : false,
    !manifest.agents ? pathExists(join(pluginPath, 'agents')) : false,
    !manifest.skills ? pathExists(join(pluginPath, 'skills')) : false,
    !manifest.outputStyles
      ? pathExists(join(pluginPath, 'output-styles'))
      : false,
  ])

  const commandsPath = join(pluginPath, 'commands')
  if (commandsDirExists) {
    plugin.commandsPath = commandsPath
  }

  // Step 3a: Process additional command paths from manifest
  if (manifest.commands) {
    // Check if it's an object mapping (record of command name → metadata)
    const firstValue = Object.values(manifest.commands)[0]
    if (
      typeof manifest.commands === 'object' &&
      !Array.isArray(manifest.commands) &&
      firstValue &&
      typeof firstValue === 'object' &&
      ('source' in firstValue || 'content' in firstValue)
    ) {
      // Object mapping format: { "about": { "source": "./README.md", ... } }
      const commandsMetadata: Record<string, CommandMetadata> = {}
      const validPaths: string[] = []

      // Parallelize pathExists checks; process results in order to keep
      // error/log ordering deterministic.
      const entries = Object.entries(manifest.commands)
      const checks = await Promise.all(
        entries.map(async ([commandName, metadata]) => {
          if (!metadata || typeof metadata !== 'object') {
            return { commandName, metadata, kind: 'skip' as const }
          }
          if (metadata.source) {
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              kind: 'source' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }
          if (metadata.content) {
            return { commandName, metadata, kind: 'content' as const }
          }
          return { commandName, metadata, kind: 'skip' as const }
        }),
      )
      for (const check of checks) {
        if (check.kind === 'skip') continue
        if (check.kind === 'content') {
          // For inline content commands, add metadata without path
          commandsMetadata[check.commandName] = check.metadata
          continue
        }
        // kind === 'source'
        if (check.exists) {
          validPaths.push(check.fullPath)
          commandsMetadata[check.commandName] = check.metadata
        } else {
          logForDebugging(
            `Command ${check.commandName} path ${check.metadata.source} specified in manifest but not found at ${check.fullPath} for ${manifest.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${check.fullPath} for ${manifest.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: check.fullPath,
            component: 'commands',
          })
        }
      }

      // Set commandsPaths if there are file-based commands
      if (validPaths.length > 0) {
        plugin.commandsPaths = validPaths
      }
      // Set commandsMetadata if there are any commands (file-based or inline)
      if (Object.keys(commandsMetadata).length > 0) {
        plugin.commandsMetadata = commandsMetadata
      }
    } else {
      // Path or array of paths format
      const commandPaths = Array.isArray(manifest.commands)
        ? manifest.commands
        : [manifest.commands]

      // Parallelize pathExists checks; process results in order.
      const checks = await Promise.all(
        commandPaths.map(async cmdPath => {
          if (typeof cmdPath !== 'string') {
            return { cmdPath, kind: 'invalid' as const }
          }
          const fullPath = join(pluginPath, cmdPath)
          return {
            cmdPath,
            kind: 'path' as const,
            fullPath,
            exists: await pathExists(fullPath),
          }
        }),
      )
      const validPaths: string[] = []
      for (const check of checks) {
        if (check.kind === 'invalid') {
          logForDebugging(
            `Unexpected command format in manifest for ${manifest.name}`,
            { level: 'error' },
          )
          continue
        }
        if (check.exists) {
          validPaths.push(check.fullPath)
        } else {
          logForDebugging(
            `Command path ${check.cmdPath} specified in manifest but not found at ${check.fullPath} for ${manifest.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${check.fullPath} for ${manifest.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: check.fullPath,
            component: 'commands',
          })
        }
      }

      if (validPaths.length > 0) {
        plugin.commandsPaths = validPaths
      }
    }
  }

  // Step 4: Register agents directory if detected
  const agentsPath = join(pluginPath, 'agents')
  if (agentsDirExists) {
    plugin.agentsPath = agentsPath
  }

  // Step 4a: Process additional agent paths from manifest
  if (manifest.agents) {
    const agentPaths = Array.isArray(manifest.agents)
      ? manifest.agents
      : [manifest.agents]

    const validPaths = await validatePluginPaths(
      agentPaths,
      pluginPath,
      manifest.name,
      source,
      'agents',
      'Agent',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.agentsPaths = validPaths
    }
  }

  // Step 4b: Register skills directory if detected
  const skillsPath = join(pluginPath, 'skills')
  if (skillsDirExists) {
    plugin.skillsPath = skillsPath
  }

  // Step 4c: Process additional skill paths from manifest
  if (manifest.skills) {
    const skillPaths = Array.isArray(manifest.skills)
      ? manifest.skills
      : [manifest.skills]

    const validPaths = await validatePluginPaths(
      skillPaths,
      pluginPath,
      manifest.name,
      source,
      'skills',
      'Skill',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.skillsPaths = validPaths
    }
  }

  // Step 4d: Register output-styles directory if detected
  const outputStylesPath = join(pluginPath, 'output-styles')
  if (outputStylesDirExists) {
    plugin.outputStylesPath = outputStylesPath
  }

  // Step 4e: Process additional output style paths from manifest
  if (manifest.outputStyles) {
    const outputStylePaths = Array.isArray(manifest.outputStyles)
      ? manifest.outputStyles
      : [manifest.outputStyles]

    const validPaths = await validatePluginPaths(
      outputStylePaths,
      pluginPath,
      manifest.name,
      source,
      'output-styles',
      'Output style',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.outputStylesPaths = validPaths
    }
  }

  // Step 5: Load hooks configuration
  let mergedHooks: HooksSettings | undefined
  const loadedHookPaths = new Set<string>() // Track loaded hook files

  // Load from standard hooks/hooks.json if it exists
  const standardHooksPath = join(pluginPath, 'hooks', 'hooks.json')
  if (await pathExists(standardHooksPath)) {
    try {
      mergedHooks = await loadPluginHooks(standardHooksPath, manifest.name)
      // Track the normalized path to prevent duplicate loading
      try {
        loadedHookPaths.add(await realpath(standardHooksPath))
      } catch {
        // If realpathSync fails, use original path
        loadedHookPaths.add(standardHooksPath)
      }
      logForDebugging(
        `Loaded hooks from standard location for plugin ${manifest.name}: ${standardHooksPath}`,
      )
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to load hooks for ${manifest.name}: ${errorMsg}`,
        {
          level: 'error',
        },
      )
      logError(toError(error))
      errors.push({
        type: 'hook-load-failed',
        source,
        plugin: manifest.name,
        hookPath: standardHooksPath,
        reason: errorMsg,
      })
    }
  }

  // Load and merge hooks from manifest.hooks if specified
  if (manifest.hooks) {
    const manifestHooksArray = Array.isArray(manifest.hooks)
      ? manifest.hooks
      : [manifest.hooks]

    for (const hookSpec of manifestHooksArray) {
      if (typeof hookSpec === 'string') {
        // Path to additional hooks file
        const hookFilePath = join(pluginPath, hookSpec)
        if (!(await pathExists(hookFilePath))) {
          logForDebugging(
            `Hooks file ${hookSpec} specified in manifest but not found at ${hookFilePath} for ${manifest.name}`,
            { level: 'error' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${hookFilePath} for ${manifest.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: hookFilePath,
            component: 'hooks',
          })
          continue
        }

        // Check if this path resolves to an already-loaded hooks file
        let normalizedPath: string
        try {
          normalizedPath = await realpath(hookFilePath)
        } catch {
          // If realpathSync fails, use original path
          normalizedPath = hookFilePath
        }

        if (loadedHookPaths.has(normalizedPath)) {
          logForDebugging(
            `Skipping duplicate hooks file for plugin ${manifest.name}: ${hookSpec} ` +
              `(resolves to already-loaded file: ${normalizedPath})`,
          )
          if (strict) {
            const errorMsg = `Duplicate hooks file detected: ${hookSpec} resolves to already-loaded file ${normalizedPath}. The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only reference additional hook files.`
            logError(new Error(errorMsg))
            errors.push({
              type: 'hook-load-failed',
              source,
              plugin: manifest.name,
              hookPath: hookFilePath,
              reason: errorMsg,
            })
          }
          continue
        }

        try {
          const additionalHooks = await loadPluginHooks(
            hookFilePath,
            manifest.name,
          )
          try {
            mergedHooks = mergeHooksSettings(mergedHooks, additionalHooks)
            loadedHookPaths.add(normalizedPath)
            logForDebugging(
              `Loaded and merged hooks from manifest for plugin ${manifest.name}: ${hookSpec}`,
            )
          } catch (mergeError) {
            const mergeErrorMsg = errorMessage(mergeError)
            logForDebugging(
              `Failed to merge hooks from ${hookSpec} for ${manifest.name}: ${mergeErrorMsg}`,
              { level: 'error' },
            )
            logError(toError(mergeError))
            errors.push({
              type: 'hook-load-failed',
              source,
              plugin: manifest.name,
              hookPath: hookFilePath,
              reason: `Failed to merge: ${mergeErrorMsg}`,
            })
          }
        } catch (error) {
          const errorMsg = errorMessage(error)
          logForDebugging(
            `Failed to load hooks from ${hookSpec} for ${manifest.name}: ${errorMsg}`,
            { level: 'error' },
          )
          logError(toError(error))
          errors.push({
            type: 'hook-load-failed',
            source,
            plugin: manifest.name,
            hookPath: hookFilePath,
            reason: errorMsg,
          })
        }
      } else if (typeof hookSpec === 'object') {
        // Inline hooks
        mergedHooks = mergeHooksSettings(mergedHooks, hookSpec as HooksSettings)
      }
    }
  }

  if (mergedHooks) {
    plugin.hooksConfig = mergedHooks
  }

  // Step 6: Load plugin settings
  // Settings can come from settings.json in the plugin directory or from manifest.settings
  // Only allowlisted keys are kept (currently: agent)
  const pluginSettings = await loadPluginSettings(pluginPath, manifest)
  if (pluginSettings) {
    plugin.settings = pluginSettings
  }

  return { plugin, errors }
}

/**
 * Schema derived from SettingsSchema that only keeps keys plugins are allowed to set.
 * Uses .strip() so unknown keys are silently removed during parsing.
 */
const PluginSettingsSchema = lazySchema(() =>
  SettingsSchema()
    .pick({
      agent: true,
    })
    .strip(),
)

/**
 * Parse raw settings through PluginSettingsSchema, returning only allowlisted keys.
 * Returns undefined if parsing fails or all keys are filtered out.
 */
function parsePluginSettings(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const result = PluginSettingsSchema().safeParse(raw)
  if (!result.success) {
    return undefined
  }
  const data = result.data
  if (Object.keys(data).length === 0) {
    return undefined
  }
  return data
}

/**
 * Load plugin settings from settings.json file or manifest.settings.
 * settings.json takes priority over manifest.settings when both exist.
 * Only allowlisted keys are included in the result.
 */
async function loadPluginSettings(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<Record<string, unknown> | undefined> {
  // Try loading settings.json from the plugin directory
  const settingsJsonPath = join(pluginPath, 'settings.json')
  try {
    const content = await readFile(settingsJsonPath, { encoding: 'utf-8' })
    const parsed = jsonParse(content)
    if (isRecord(parsed)) {
      const filtered = parsePluginSettings(parsed)
      if (filtered) {
        logForDebugging(
          `Loaded settings from settings.json for plugin ${manifest.name}`,
        )
        return filtered
      }
    }
  } catch (e: unknown) {
    // Missing/inaccessible is expected - settings.json is optional
    if (!isFsInaccessible(e)) {
      logForDebugging(
        `Failed to parse settings.json for plugin ${manifest.name}: ${e}`,
        { level: 'warn' },
      )
    }
  }

  // Fall back to manifest.settings
  if (manifest.settings) {
    const filtered = parsePluginSettings(
      manifest.settings as Record<string, unknown>,
    )
    if (filtered) {
      logForDebugging(
        `Loaded settings from manifest for plugin ${manifest.name}`,
      )
      return filtered
    }
  }

  return undefined
}

/**
 * Merge two HooksSettings objects
 */
function mergeHooksSettings(
  base: HooksSettings | undefined,
  additional: HooksSettings,
): HooksSettings {
  if (!base) {
    return additional
  }

  const merged = { ...base }

  for (const [event, matchers] of Object.entries(additional)) {
    if (!merged[event as keyof HooksSettings]) {
      merged[event as keyof HooksSettings] = matchers
    } else {
      // Merge matchers for this event
      merged[event as keyof HooksSettings] = [
        ...(merged[event as keyof HooksSettings] || []),
        ...matchers,
      ]
    }
  }

  return merged
}

/**
 * Shared discovery/policy/merge pipeline for both load modes.
 *
 * Resolves enabledPlugins → marketplace entries, runs enterprise policy
 * checks, pre-loads catalogs, then dispatches each entry to the full or
 * cache-only per-entry loader. The ONLY difference between loadAllPlugins
 * and loadAllPluginsCacheOnly is which loader runs — discovery and policy
 * are identical.
 */
async function loadPluginsFromMarketplaces({
  cacheOnly,
}: {
  cacheOnly: boolean
}): Promise<{
  plugins: LoadedPlugin[]
  errors: PluginError[]
}> {
  const settings = getSettings_DEPRECATED()
  // Merge --add-dir plugins at lowest priority; standard settings win on conflict
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(settings.enabledPlugins || {}),
  }
  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  // Filter to plugin@marketplace format and validate
  const marketplacePluginEntries = Object.entries(enabledPlugins).filter(
    ([key, value]) => {
      // Check if it's in plugin@marketplace format (includes both enabled and disabled)
      const isValidFormat = PluginIdSchema().safeParse(key).success
      if (!isValidFormat || value === undefined) return false
      // Skip built-in plugins — handled separately by getBuiltinPlugins()
      const { marketplace } = parsePluginIdentifier(key)
      return marketplace !== BUILTIN_MARKETPLACE_NAME
    },
  )

  // Load known marketplaces config to look up sources for policy checking.
  // Use the Safe variant so a corrupted config file doesn't crash all plugin
  // loading — this is a read-only path, so returning {} degrades gracefully.
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()

  // Fail-closed guard for enterprise policy: if a policy IS configured and we
  // cannot resolve a marketplace's source (config returned {} due to corruption,
  // or entry missing), we must NOT silently skip the policy check and load the
  // plugin anyway. Before Safe, a corrupted config crashed everything (loud,
  // fail-closed). With Safe + no guard, the policy check short-circuits on
  // undefined marketplaceConfig and the fallback path (getPluginByIdCacheOnly)
  // loads the plugin unchecked — a silent fail-open. This guard restores
  // fail-closed: unknown source + active policy → block.
  //
  // Allowlist: any value (including []) is active — empty allowlist = deny all.
  // Blocklist: empty [] is a semantic no-op — only non-empty counts as active.
  const strictAllowlist = getStrictKnownMarketplaces()
  const blocklist = getBlockedMarketplaces()
  const hasEnterprisePolicy =
    strictAllowlist !== null || (blocklist !== null && blocklist.length > 0)

  // Pre-load marketplace catalogs once per marketplace rather than re-reading
  // known_marketplaces.json + marketplace.json for every plugin. This is the
  // hot path — with N plugins across M marketplaces, the old per-plugin
  // getPluginByIdCacheOnly() did 2N config reads + N catalog reads; this does M.
  const uniqueMarketplaces = new Set(
    marketplacePluginEntries
      .map(([pluginId]) => parsePluginIdentifier(pluginId).marketplace)
      .filter((m): m is string => !!m),
  )
  const marketplaceCatalogs = new Map<
    string,
    Awaited<ReturnType<typeof getMarketplaceCacheOnly>>
  >()
  await Promise.all(
    [...uniqueMarketplaces].map(async name => {
      marketplaceCatalogs.set(name, await getMarketplaceCacheOnly(name))
    }),
  )

  // Look up installed versions once so the first-pass ZIP cache check
  // can hit even when the marketplace entry omits `version`.
  const installedPluginsData = getInMemoryInstalledPlugins()

  // Load all marketplace plugins in parallel for faster startup
  const results = await Promise.allSettled(
    marketplacePluginEntries.map(async ([pluginId, enabledValue]) => {
      const { name: pluginName, marketplace: marketplaceName } =
        parsePluginIdentifier(pluginId)

      // Check if marketplace source is allowed by enterprise policy
      const marketplaceConfig = knownMarketplaces[marketplaceName!]

      // Fail-closed: if enterprise policy is active and we can't look up the
      // marketplace source (config corrupted/empty, or entry missing), block
      // rather than silently skip the policy check. See hasEnterprisePolicy
      // comment above for the fail-open hazard this guards against.
      //
      // This also fires for the "stale enabledPlugins entry with no registered
      // marketplace" case, which is a UX trade-off: the user gets a policy
      // error instead of plugin-not-found. Accepted because the fallback path
      // (getPluginByIdCacheOnly) does a raw cast of known_marketplaces.json
      // with NO schema validation — if one entry is malformed enough to fail
      // our validation but readable enough for the raw cast, it would load
      // unchecked. Unverifiable source + active policy → block, always.
      if (!marketplaceConfig && hasEnterprisePolicy) {
        // We can't know whether the unverifiable source would actually be in
        // the blocklist or not in the allowlist — so pick the error variant
        // that matches whichever policy IS configured. If an allowlist exists,
        // "not in allowed list" is the right framing; if only a blocklist
        // exists, "blocked by blocklist" is less misleading than showing an
        // empty allowed-sources list.
        errors.push({
          type: 'marketplace-blocked-by-policy',
          source: pluginId,
          plugin: pluginName,
          marketplace: marketplaceName!,
          blockedByBlocklist: strictAllowlist === null,
          allowedSources: (strictAllowlist ?? []).map(s =>
            formatSourceForDisplay(s),
          ),
        })
        return null
      }

      if (
        marketplaceConfig &&
        !isSourceAllowedByPolicy(marketplaceConfig.source)
      ) {
        // Check if explicitly blocked vs not in allowlist for better error context
        const isBlocked = isSourceInBlocklist(marketplaceConfig.source)
        const allowlist = getStrictKnownMarketplaces() || []
        errors.push({
          type: 'marketplace-blocked-by-policy',
          source: pluginId,
          plugin: pluginName,
          marketplace: marketplaceName!,
          blockedByBlocklist: isBlocked,
          allowedSources: isBlocked
            ? []
            : allowlist.map(s => formatSourceForDisplay(s)),
        })
        return null
      }

      // Look up plugin entry from pre-loaded marketplace catalog (no per-plugin I/O).
      // Fall back to getPluginByIdCacheOnly if the catalog couldn't be pre-loaded.
      let result: Awaited<ReturnType<typeof getPluginByIdCacheOnly>> = null
      const marketplace = marketplaceCatalogs.get(marketplaceName!)
      if (marketplace && marketplaceConfig) {
        const entry = marketplace.plugins.find(p => p.name === pluginName)
        if (entry) {
          result = {
            entry,
            marketplaceInstallLocation: marketplaceConfig.installLocation,
          }
        }
      } else {
        result = await getPluginByIdCacheOnly(pluginId)
      }

      if (!result) {
        errors.push({
          type: 'plugin-not-found',
          source: pluginId,
          pluginId: pluginName!,
          marketplace: marketplaceName!,
        })
        return null
      }

      // installed_plugins.json records what's actually cached on disk
      // (version for the full loader's first-pass probe, installPath for
      // the cache-only loader's direct read).
      const installEntry = installedPluginsData.plugins[pluginId]?.[0]
      return cacheOnly
        ? loadPluginFromMarketplaceEntryCacheOnly(
            result.entry,
            result.marketplaceInstallLocation,
            pluginId,
            enabledValue === true,
            errors,
            installEntry?.installPath,
          )
        : loadPluginFromMarketplaceEntry(
            result.entry,
            result.marketplaceInstallLocation,
            pluginId,
            enabledValue === true,
            errors,
            installEntry?.version,
          )
    }),
  )

  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value) {
      plugins.push(result.value)
    } else if (result.status === 'rejected') {
      const err = toError(result.reason)
      logError(err)
      const pluginId = marketplacePluginEntries[i]![0]
      errors.push({
        type: 'generic-error',
        source: pluginId,
        plugin: pluginId.split('@')[0],
        error: err.message,
      })
    }
  }

  return { plugins, errors }
}

/**
 * Cache-only variant of loadPluginFromMarketplaceEntry.
 *
 * Skips network (cachePlugin) and disk-copy (copyPluginToVersionedCache).
 * Reads directly from the recorded installPath; if missing, emits
 * 'plugin-cache-miss'. Still extracts ZIP-cached plugins (local, fast).
 */
async function loadPluginFromMarketplaceEntryCacheOnly(
  entry: PluginMarketplaceEntry,
  marketplaceInstallLocation: string,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installPath: string | undefined,
): Promise<LoadedPlugin | null> {
  let pluginPath: string

  if (typeof entry.source === 'string') {
    // Local relative path — read from the marketplace source dir directly.
    // Skip copyPluginToVersionedCache; startup doesn't need a fresh copy.
    let marketplaceDir: string
    try {
      marketplaceDir = (await stat(marketplaceInstallLocation)).isDirectory()
        ? marketplaceInstallLocation
        : join(marketplaceInstallLocation, '..')
    } catch {
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: marketplaceInstallLocation,
      })
      return null
    }
    pluginPath = join(marketplaceDir, entry.source)
    // finishLoadingPluginFromPath reads pluginPath — its error handling
    // surfaces ENOENT as a load failure, no need to pre-check here.
  } else {
    // External source (npm/github/url/git-subdir) — use recorded installPath.
    if (!installPath || !(await pathExists(installPath))) {
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: installPath ?? '(not recorded)',
      })
      return null
    }
    pluginPath = installPath
  }

  // Zip cache extraction — must still happen in cacheOnly mode (invariant 4)
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(
      sessionDir,
      pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'),
    )
    try {
      await extractZipToDirectory(pluginPath, extractDir)
      pluginPath = extractDir
    } catch (error) {
      logForDebugging(`Failed to extract plugin ZIP ${pluginPath}: ${error}`, {
        level: 'error',
      })
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: pluginPath,
      })
      return null
    }
  }

  // Delegate to the shared tail — identical to the full loader from here
  return finishLoadingPluginFromPath(
    entry,
    pluginId,
    enabled,
    errorsOut,
    pluginPath,
  )
}

/**
 * Load a plugin from a marketplace entry based on its source configuration.
 *
 * Handles different source types:
 * - Relative path: Loads from marketplace repo directory
 * - npm/github/url: Caches then loads from cache
 *
 * @param installedVersion - Version from installed_plugins.json, used as a
 *   first-pass hint for the versioned cache lookup when the marketplace entry
 *   omits `version`. Avoids re-cloning external plugins just to discover the
 *   version we already recorded at install time.
 *
 * Returns both the loaded plugin and any errors encountered during loading.
 * Errors include missing component files and hook load failures.
 */
async function loadPluginFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
  marketplaceInstallLocation: string,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installedVersion?: string,
): Promise<LoadedPlugin | null> {
  logForDebugging(
    `Loading plugin ${entry.name} from source: ${jsonStringify(entry.source)}`,
  )
  let pluginPath: string

  if (typeof entry.source === 'string') {
    // Relative path - resolve relative to marketplace install location
    const marketplaceDir = (
      await stat(marketplaceInstallLocation)
    ).isDirectory()
      ? marketplaceInstallLocation
      : join(marketplaceInstallLocation, '..')
    const sourcePluginPath = join(marketplaceDir, entry.source)

    if (!(await pathExists(sourcePluginPath))) {
      const error = new Error(`Plugin path not found: ${sourcePluginPath}`)
      logForDebugging(`Plugin path not found: ${sourcePluginPath}`, {
        level: 'error',
      })
      logError(error)
      errorsOut.push({
        type: 'generic-error',
        source: pluginId,
        error: `Plugin directory not found at path: ${sourcePluginPath}. Check that the marketplace entry has the correct path.`,
      })
      return null
    }

    // Always copy local plugins to versioned cache
    try {
      // Try to load manifest from plugin directory to check for version field first
      const manifestPath = join(
        sourcePluginPath,
        '.claude-plugin',
        'plugin.json',
      )
      let pluginManifest: PluginManifest | undefined
      try {
        pluginManifest = await loadPluginManifest(
          manifestPath,
          entry.name,
          entry.source,
        )
      } catch {
        // Manifest loading failed - will fall back to provided version or git SHA
      }

      // Calculate version with fallback order:
      // 1. Plugin manifest version, 2. Marketplace entry version, 3. Git SHA, 4. 'unknown'
      const version = await calculatePluginVersion(
        pluginId,
        entry.source,
        pluginManifest,
        marketplaceDir,
        entry.version, // Marketplace entry version as fallback
      )

      // Copy to versioned cache
      pluginPath = await copyPluginToVersionedCache(
        sourcePluginPath,
        pluginId,
        version,
        entry,
        marketplaceDir,
      )

      logForDebugging(
        `Resolved local plugin ${entry.name} to versioned cache: ${pluginPath}`,
      )
    } catch (error) {
      // If copy fails, fall back to loading from marketplace directly
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to copy plugin ${entry.name} to versioned cache: ${errorMsg}. Using marketplace path.`,
        { level: 'warn' },
      )
      pluginPath = sourcePluginPath
    }
  } else {
    // External source (npm, github, url, pip) - always use versioned cache
    try {
      // Calculate version with fallback order:
      // 1. No manifest yet, 2. installed_plugins.json version,
      //    3. Marketplace entry version, 4. source.sha (pinned commits — the
      //    exact value the post-clone call at cached.gitCommitSha would see),
      //    5. 'unknown' → ref-tracked, falls through to clone by design.
      const version = await calculatePluginVersion(
        pluginId,
        entry.source,
        undefined,
        undefined,
        installedVersion ?? entry.version,
        'sha' in entry.source ? entry.source.sha : undefined,
      )

      const versionedPath = getVersionedCachePath(pluginId, version)

      // Check for cached version — ZIP file (zip cache mode) or directory
      const zipPath = getVersionedZipCachePath(pluginId, version)
      if (isPluginZipCacheEnabled() && (await pathExists(zipPath))) {
        logForDebugging(
          `Using versioned cached plugin ZIP ${entry.name} from ${zipPath}`,
        )
        pluginPath = zipPath
      } else if (await pathExists(versionedPath)) {
        logForDebugging(
          `Using versioned cached plugin ${entry.name} from ${versionedPath}`,
        )
        pluginPath = versionedPath
      } else {
        // Seed cache probe (CCR pre-baked images, read-only). Seed content is
        // frozen at image build time — no freshness concern, 'whatever's there'
        // is what the image builder put there. Primary cache is NOT probed
        // here; ref-tracked sources fall through to clone (the re-clone IS
        // the freshness mechanism). If the clone fails, the plugin is simply
        // disabled for this session — errorsOut.push below surfaces it.
        const seedPath =
          (await probeSeedCache(pluginId, version)) ??
          (version === 'unknown'
            ? await probeSeedCacheAnyVersion(pluginId)
            : null)
        if (seedPath) {
          pluginPath = seedPath
          logForDebugging(
            `Using seed cache for external plugin ${entry.name} at ${seedPath}`,
          )
        } else {
          // Download to temp location, then copy to versioned cache
          const cached = await cachePlugin(entry.source, {
            manifest: { name: entry.name },
          })

          // If the pre-clone version was deterministic (source.sha /
          // entry.version / installedVersion), REUSE it. The post-clone
          // recomputation with cached.manifest can return a DIFFERENT value
          // — manifest.version (step 1) outranks gitCommitSha (step 3) —
          // which would cache at e.g. "2.0.0/" while every warm start
          // probes "{sha12}-{hash}/". Mismatched keys = re-clone forever.
          // Recomputation is only needed when pre-clone was 'unknown'
          // (ref-tracked, no hints) — the clone is the ONLY way to learn.
          const actualVersion =
            version !== 'unknown'
              ? version
              : await calculatePluginVersion(
                  pluginId,
                  entry.source,
                  cached.manifest,
                  cached.path,
                  installedVersion ?? entry.version,
                  cached.gitCommitSha,
                )

          // Copy to versioned cache
          // For external sources, marketplaceDir is not applicable (already downloaded)
          pluginPath = await copyPluginToVersionedCache(
            cached.path,
            pluginId,
            actualVersion,
            entry,
            undefined,
          )

          // Clean up temp path
          if (cached.path !== pluginPath) {
            await rm(cached.path, { recursive: true, force: true })
          }
        }
      }
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to cache plugin ${entry.name}: ${errorMsg}`, {
        level: 'error',
      })
      logError(toError(error))
      errorsOut.push({
        type: 'generic-error',
        source: pluginId,
        error: `Failed to download/cache plugin ${entry.name}: ${errorMsg}`,
      })
      return null
    }
  }

  // Zip cache mode: extract ZIP to session temp dir before loading
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(
      sessionDir,
      pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'),
    )
    try {
      await extractZipToDirectory(pluginPath, extractDir)
      logForDebugging(`Extracted plugin ZIP to session dir: ${extractDir}`)
      pluginPath = extractDir
    } catch (error) {
      // Corrupt ZIP: delete it so next install attempt re-creates it
      logForDebugging(
        `Failed to extract plugin ZIP ${pluginPath}, deleting corrupt file: ${error}`,
      )
      await rm(pluginPath, { force: true }).catch(() => {})
      throw error
    }
  }

  return finishLoadingPluginFromPath(
    entry,
    pluginId,
    enabled,
    errorsOut,
    pluginPath,
  )
}

/**
 * Shared tail of both loadPluginFromMarketplaceEntry variants.
 *
 * Once pluginPath is resolved (via clone, cache, or installPath lookup),
 * the rest of the load — manifest probe, createPluginFromPath, marketplace
 * entry supplementation — is identical. Extracted so the cache-only path
 * doesn't duplicate ~500 lines.
 */
async function finishLoadingPluginFromPath(
  entry: PluginMarketplaceEntry,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  pluginPath: string,
): Promise<LoadedPlugin | null> {
  const errors: PluginError[] = []

  // Check if plugin.json exists to determine if we should use marketplace manifest
  const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json')
  const hasManifest = await pathExists(manifestPath)

  const { plugin, errors: pluginErrors } = await createPluginFromPath(
    pluginPath,
    pluginId,
    enabled,
    entry.name,
    entry.strict ?? true, // Respect marketplace entry's strict setting
  )
  errors.push(...pluginErrors)

  // Set sha from source if available (for github and url source types)
  if (
    typeof entry.source === 'object' &&
    'sha' in entry.source &&
    entry.source.sha
  ) {
    plugin.sha = entry.source.sha
  }

  // If there's no plugin.json, use marketplace entry as manifest (regardless of strict mode)
  if (!hasManifest) {
    plugin.manifest = {
      ...entry,
      id: undefined,
      source: undefined,
      strict: undefined,
    } as PluginManifest
    plugin.name = plugin.manifest.name

    // Process commands from marketplace entry
    if (entry.commands) {
      // Check if it's an object mapping
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // Object mapping format
        const commandsMetadata: Record<string, CommandMetadata> = {}
        const validPaths: string[] = []

        // Parallelize pathExists checks; process results in order.
        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              skip: false as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) continue
          if (check.exists) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            logForDebugging(
              `Command ${check.commandName} path ${check.metadata.source} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        // Path or array of paths format
        const commandPaths = Array.isArray(entry.commands)
          ? entry.commands
          : [entry.commands]

        // Parallelize pathExists checks; process results in order.
        const checks = await Promise.all(
          commandPaths.map(async cmdPath => {
            if (typeof cmdPath !== 'string') {
              return { cmdPath, kind: 'invalid' as const }
            }
            const fullPath = join(pluginPath, cmdPath)
            return {
              cmdPath,
              kind: 'path' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        const validPaths: string[] = []
        for (const check of checks) {
          if (check.kind === 'invalid') {
            logForDebugging(
              `Unexpected command format in marketplace entry for ${entry.name}`,
              { level: 'error' },
            )
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
          } else {
            logForDebugging(
              `Command path ${check.cmdPath} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
        }
      }
    }

    // Process agents from marketplace entry
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents)
        ? entry.agents
        : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = validPaths
      }
    }

    // Process skills from marketplace entry
    if (entry.skills) {
      logForDebugging(
        `Processing ${Array.isArray(entry.skills) ? entry.skills.length : 1} skill paths for plugin ${entry.name}`,
      )
      const skillPaths = Array.isArray(entry.skills)
        ? entry.skills
        : [entry.skills]

      // Parallelize pathExists checks; process results in order.
      // Note: previously this loop called pathExists() TWICE per iteration
      // (once in a debug log template, once in the if) — now called once.
      const checks = await Promise.all(
        skillPaths.map(async skillPath => {
          const fullPath = join(pluginPath, skillPath)
          return { skillPath, fullPath, exists: await pathExists(fullPath) }
        }),
      )
      const validPaths: string[] = []
      for (const { skillPath, fullPath, exists } of checks) {
        logForDebugging(
          `Checking skill path: ${skillPath} -> ${fullPath} (exists: ${exists})`,
        )
        if (exists) {
          validPaths.push(fullPath)
        } else {
          logForDebugging(
            `Skill path ${skillPath} from marketplace entry not found at ${fullPath} for ${entry.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${fullPath} for ${entry.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source: pluginId,
            plugin: entry.name,
            path: fullPath,
            component: 'skills',
          })
        }
      }

      logForDebugging(
        `Found ${validPaths.length} valid skill paths for plugin ${entry.name}, setting skillsPaths`,
      )
      if (validPaths.length > 0) {
        plugin.skillsPaths = validPaths
      }
    } else {
      logForDebugging(`Plugin ${entry.name} has no entry.skills defined`)
    }

    // Process output styles from marketplace entry
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = validPaths
      }
    }

    // Process inline hooks from marketplace entry
    if (entry.hooks) {
      plugin.hooksConfig = entry.hooks as HooksSettings
    }
  } else if (
    !entry.strict &&
    hasManifest &&
    (entry.commands ||
      entry.agents ||
      entry.skills ||
      entry.hooks ||
      entry.outputStyles)
  ) {
    // In non-strict mode with plugin.json, marketplace entries for commands/agents/skills/hooks/outputStyles are conflicts
    const error = new Error(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
    )
    logForDebugging(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
      { level: 'error' },
    )
    logError(error)
    errorsOut.push({
      type: 'generic-error',
      source: pluginId,
      error: `Plugin ${entry.name} has conflicting manifests: both plugin.json and marketplace entry specify components. Set strict: true in marketplace entry or remove component specs from one location.`,
    })
    return null
  } else if (hasManifest) {
    // Has plugin.json - marketplace can supplement commands/agents/skills/hooks/outputStyles

    // Supplement commands from marketplace entry
    if (entry.commands) {
      // Check if it's an object mapping
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // Object mapping format - merge metadata
        const commandsMetadata: Record<string, CommandMetadata> = {
          ...(plugin.commandsMetadata || {}),
        }
        const validPaths: string[] = []

        // Parallelize pathExists checks; process results in order.
        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              skip: false as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) continue
          if (check.exists) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            logForDebugging(
              `Command ${check.commandName} path ${check.metadata.source} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [
            ...(plugin.commandsPaths || []),
            ...validPaths,
          ]
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        // Path or array of paths format
        const commandPaths = Array.isArray(entry.commands)
          ? entry.commands
          : [entry.commands]

        // Parallelize pathExists checks; process results in order.
        const checks = await Promise.all(
          commandPaths.map(async cmdPath => {
            if (typeof cmdPath !== 'string') {
              return { cmdPath, kind: 'invalid' as const }
            }
            const fullPath = join(pluginPath, cmdPath)
            return {
              cmdPath,
              kind: 'path' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        const validPaths: string[] = []
        for (const check of checks) {
          if (check.kind === 'invalid') {
            logForDebugging(
              `Unexpected command format in marketplace entry for ${entry.name}`,
              { level: 'error' },
            )
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
          } else {
            logForDebugging(
              `Command path ${check.cmdPath} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [
            ...(plugin.commandsPaths || []),
            ...validPaths,
          ]
        }
      }
    }

    // Supplement agents from marketplace entry
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents)
        ? entry.agents
        : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = [...(plugin.agentsPaths || []), ...validPaths]
      }
    }

    // Supplement skills from marketplace entry
    if (entry.skills) {
      const skillPaths = Array.isArray(entry.skills)
        ? entry.skills
        : [entry.skills]

      const validPaths = await validatePluginPaths(
        skillPaths,
        pluginPath,
        entry.name,
        pluginId,
        'skills',
        'Skill',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.skillsPaths = [...(plugin.skillsPaths || []), ...validPaths]
      }
    }

    // Supplement output styles from marketplace entry
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = [
          ...(plugin.outputStylesPaths || []),
          ...validPaths,
        ]
      }
    }

    // Supplement hooks from marketplace entry
    if (entry.hooks) {
      plugin.hooksConfig = {
        ...(plugin.hooksConfig || {}),
        ...(entry.hooks as HooksSettings),
      }
    }
  }

  errorsOut.push(...errors)
  return plugin
}

/**
 * Load session-only plugins from --plugin-dir CLI flag.
 *
 * These plugins are loaded directly without going through the marketplace system.
 * They appear with source='plugin-name@inline' and are always enabled for the current session.
 *
 * @param sessionPluginPaths - Array of plugin directory paths from CLI
 * @returns LoadedPlugin objects and any errors encountered
 */
async function loadSessionOnlyPlugins(
  sessionPluginPaths: Array<string>,
): Promise<{ plugins: LoadedPlugin[]; errors: PluginError[] }> {
  if (sessionPluginPaths.length === 0) {
    return { plugins: [], errors: [] }
  }

  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  for (const [index, pluginPath] of sessionPluginPaths.entries()) {
    try {
      const resolvedPath = resolve(pluginPath)

      if (!(await pathExists(resolvedPath))) {
        logForDebugging(
          `Plugin path does not exist: ${resolvedPath}, skipping`,
          { level: 'warn' },
        )
        errors.push({
          type: 'path-not-found',
          source: `inline[${index}]`,
          path: resolvedPath,
          component: 'commands',
        })
        continue
      }

      const dirName = basename(resolvedPath)
      const { plugin, errors: pluginErrors } = await createPluginFromPath(
        resolvedPath,
        `${dirName}@inline`, // temporary, will be updated after we know the real name
        true, // always enabled
        dirName,
      )

      // Update source to use the actual plugin name from manifest
      plugin.source = `${plugin.name}@inline`
      plugin.repository = `${plugin.name}@inline`

      plugins.push(plugin)
      errors.push(...pluginErrors)

      logForDebugging(`Loaded inline plugin from path: ${plugin.name}`)
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to load session plugin from ${pluginPath}: ${errorMsg}`,
        { level: 'warn' },
      )
      errors.push({
        type: 'generic-error',
        source: `inline[${index}]`,
        error: `Failed to load plugin: ${errorMsg}`,
      })
    }
  }

  if (plugins.length > 0) {
    logForDebugging(
      `Loaded ${plugins.length} session-only plugins from --plugin-dir`,
    )
  }

  return { plugins, errors }
}

/**
 * Merge plugins from session (--plugin-dir), marketplace (installed), and
 * builtin sources. Session plugins override marketplace plugins with the
 * same name — the user explicitly pointed at a directory for this session.
 *
 * Exception: marketplace plugins locked by managed settings (policySettings)
 * cannot be overridden. Enterprise admin intent beats local dev convenience.
 * When a session plugin collides with a managed one, the session copy is
 * dropped and an error is returned for surfacing.
 *
 * Without this dedup, both versions sat in the array and marketplace won
 * on first-match, making --plugin-dir useless for iterating on an
 * installed plugin.
 */
export function mergePluginSources(sources: {
  session: LoadedPlugin[]
  marketplace: LoadedPlugin[]
  builtin: LoadedPlugin[]
  managedNames?: Set<string> | null
}): { plugins: LoadedPlugin[]; errors: PluginError[] } {
  const errors: PluginError[] = []
  const managed = sources.managedNames

  // Managed settings win over --plugin-dir. Drop session plugins whose
  // name appears in policySettings.enabledPlugins (whether force-enabled
  // OR force-disabled — both are admin intent that --plugin-dir must not
  // bypass). Surface an error so the user knows why their dev copy was
  // ignored.
  //
  // NOTE: managedNames contains the pluginId prefix (entry.name), which is
  // expected to equal manifest.name by convention (schema description at
  // schemas.ts PluginMarketplaceEntry.name). If a marketplace publishes a
  // plugin where entry.name ≠ manifest.name, this guard will silently miss —
  // but that's a marketplace misconfiguration that breaks other things too
  // (e.g., ManagePlugins constructs pluginIds from manifest.name).
  const sessionPlugins = sources.session.filter(p => {
    if (managed?.has(p.name)) {
      logForDebugging(
        `Plugin "${p.name}" from --plugin-dir is blocked by managed settings`,
        { level: 'warn' },
      )
      errors.push({
        type: 'generic-error',
        source: p.source,
        plugin: p.name,
        error: `--plugin-dir copy of "${p.name}" ignored: plugin is locked by managed settings`,
      })
      return false
    }
    return true
  })

  const sessionNames = new Set(sessionPlugins.map(p => p.name))
  const marketplacePlugins = sources.marketplace.filter(p => {
    if (sessionNames.has(p.name)) {
      logForDebugging(
        `Plugin "${p.name}" from --plugin-dir overrides installed version`,
      )
      return false
    }
    return true
  })
  // Session first, then non-overridden marketplace, then builtin.
  // Downstream first-match consumers see session plugins before
  // installed ones for any that slipped past the name filter.
  return {
    plugins: [...sessionPlugins, ...marketplacePlugins, ...sources.builtin],
    errors,
  }
}

/**
 * Main plugin loading function that discovers and loads all plugins.
 *
 * This function is memoized to avoid repeated filesystem scanning and is
 * the primary entry point for the plugin system. It discovers plugins from
 * multiple sources and returns categorized results.
 *
 * Loading order and precedence (see mergePluginSources):
 * 1. Session-only plugins (from --plugin-dir CLI flag) — override
 *    installed plugins with the same name, UNLESS that plugin is
 *    locked by managed settings (policySettings, either force-enabled
 *    or force-disabled)
 * 2. Marketplace-based plugins (plugin@marketplace format from settings)
 * 3. Built-in plugins shipped with the CLI
 *
 * Name collision: session plugin wins over installed. The user explicitly
 * pointed at a directory for this session — that intent beats whatever
 * is installed. Exception: managed settings (enterprise policy) win over
 * --plugin-dir. Admin intent beats local dev convenience.
 *
 * Error collection:
 * - Non-fatal errors are collected and returned
 * - System continues loading other plugins on errors
 * - Errors include source information for debugging
 *
 * @returns Promise resolving to categorized plugin results:
 *   - enabled: Array of enabled LoadedPlugin objects
 *   - disabled: Array of disabled LoadedPlugin objects
 *   - errors: Array of loading errors with source information
 */
export const loadAllPlugins = memoize(async (): Promise<PluginLoadResult> => {
  const result = await assemblePluginLoadResult(() =>
    loadPluginsFromMarketplaces({ cacheOnly: false }),
  )
  // A fresh full-load result is strictly valid for cache-only callers
  // (both variants share assemblePluginLoadResult). Warm the separate
  // memoize so refreshActivePlugins()'s downstream getPluginCommands() /
  // getAgentDefinitionsWithOverrides() — which now call
  // loadAllPluginsCacheOnly — see just-cloned plugins instead of reading
  // an installed_plugins.json that nothing writes mid-session.
  loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve(result))
  return result
})

/**
 * Cache-only variant of loadAllPlugins.
 *
 * Same merge/dependency/settings logic, but the marketplace loader never
 * hits the network (no cachePlugin, no copyPluginToVersionedCache). Reads
 * from installed_plugins.json's installPath. Plugins not on disk emit
 * 'plugin-cache-miss' and are skipped.
 *
 * Use this in startup consumers (getCommands, loadPluginAgents, MCP/LSP
 * config) so interactive startup never blocks on git clones for ref-tracked
 * plugins. Use loadAllPlugins() in explicit refresh paths (/plugins,
 * refresh.ts, headlessPluginInstall) where fresh source is the intent.
 *
 * CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 delegates to the full loader — that
 * mode explicitly opts into blocking install before first query, and
 * main.tsx's getClaudeCodeMcpConfigs()/getInitialSettings().agent run
 * BEFORE runHeadless() can warm this cache. First-run CCR/headless has
 * no installed_plugins.json, so cache-only would miss plugin MCP servers
 * and plugin settings (the agent key). The interactive startup win is
 * preserved since interactive mode doesn't set SYNC_PLUGIN_INSTALL.
 *
 * Separate memoize cache from loadAllPlugins — a cache-only result must
 * never satisfy a caller that wants fresh source. The reverse IS valid:
 * loadAllPlugins warms this cache on completion so refresh paths that run
 * the full loader don't get plugin-cache-miss from their downstream
 * cache-only consumers.
 */
export const loadAllPluginsCacheOnly = memoize(
  async (): Promise<PluginLoadResult> => {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      return loadAllPlugins()
    }
    return assemblePluginLoadResult(() =>
      loadPluginsFromMarketplaces({ cacheOnly: true }),
    )
  },
)

/**
 * Shared body of loadAllPlugins and loadAllPluginsCacheOnly.
 *
 * The only difference between the two is which marketplace loader runs —
 * session plugins, builtins, merge, verifyAndDemote, and cachePluginSettings
 * are identical (invariants 1-3).
 */
async function assemblePluginLoadResult(
  marketplaceLoader: () => Promise<{
    plugins: LoadedPlugin[]
    errors: PluginError[]
  }>,
): Promise<PluginLoadResult> {
  // Load marketplace plugins and session-only plugins in parallel.
  // getInlinePlugins() is a synchronous state read with no dependency on
  // marketplace loading, so these two sources can be fetched concurrently.
  const inlinePlugins = getInlinePlugins()
  const [marketplaceResult, sessionResult] = await Promise.all([
    marketplaceLoader(),
    inlinePlugins.length > 0
      ? loadSessionOnlyPlugins(inlinePlugins)
      : Promise.resolve({ plugins: [], errors: [] }),
  ])
  // 3. Load built-in plugins that ship with the CLI
  const builtinResult = getBuiltinPlugins()

  // Session plugins (--plugin-dir) override installed ones by name,
  // UNLESS the installed plugin is locked by managed settings
  // (policySettings). See mergePluginSources() for details.
  const { plugins: allPlugins, errors: mergeErrors } = mergePluginSources({
    session: sessionResult.plugins,
    marketplace: marketplaceResult.plugins,
    builtin: [...builtinResult.enabled, ...builtinResult.disabled],
    managedNames: getManagedPluginNames(),
  })
  const allErrors = [
    ...marketplaceResult.errors,
    ...sessionResult.errors,
    ...mergeErrors,
  ]

  // Verify dependencies. Runs AFTER the parallel load — deps are presence
  // checks, not load-order, so no topological sort needed. Demotion is
  // session-local: does NOT write settings (user fixes intent via /doctor).
  const { demoted, errors: depErrors } = verifyAndDemote(allPlugins)
  for (const p of allPlugins) {
    if (demoted.has(p.source)) p.enabled = false
  }
  allErrors.push(...depErrors)

  const enabledPlugins = allPlugins.filter(p => p.enabled)
  logForDebugging(
    `Found ${allPlugins.length} plugins (${enabledPlugins.length} enabled, ${allPlugins.length - enabledPlugins.length} disabled)`,
  )

  // 3. Cache plugin settings for synchronous access by the settings cascade
  cachePluginSettings(enabledPlugins)

  return {
    enabled: enabledPlugins,
    disabled: allPlugins.filter(p => !p.enabled),
    errors: allErrors,
  }
}

/**
 * Clears the memoized plugin cache.
 *
 * Call this when plugins are installed, removed, or settings change
 * to force a fresh scan on the next loadAllPlugins call.
 *
 * Use cases:
 * - After installing/uninstalling plugins
 * - After modifying .claude-plugin/ directory (for export)
 * - After changing enabledPlugins settings
 * - When debugging plugin loading issues
 */
export function clearPluginCache(reason?: string): void {
  if (reason) {
    logForDebugging(
      `clearPluginCache: invalidating loadAllPlugins cache (${reason})`,
    )
  }
  loadAllPlugins.cache?.clear?.()
  loadAllPluginsCacheOnly.cache?.clear?.()
  // If a plugin previously contributed settings, the session settings cache
  // holds a merged result that includes them. cachePluginSettings() on reload
  // won't bust the cache when the new base is empty (the startup perf win),
  // so bust it here to drop stale plugin overrides. When the base is already
  // undefined (startup, or no prior plugin settings) this is a no-op.
  if (getPluginSettingsBase() !== undefined) {
    resetSettingsCache()
  }
  clearPluginSettingsBase()
  // TODO: Clear installed plugins cache when installedPluginsManager is implemented
}

/**
 * Merge settings from all enabled plugins into a single record.
 * Later plugins override earlier ones for the same key.
 * Only allowlisted keys are included (filtering happens at load time).
 */
function mergePluginSettings(
  plugins: LoadedPlugin[],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined

  for (const plugin of plugins) {
    if (!plugin.settings) {
      continue
    }

    if (!merged) {
      merged = {}
    }

    for (const [key, value] of Object.entries(plugin.settings)) {
      if (key in merged) {
        logForDebugging(
          `Plugin "${plugin.name}" overrides setting "${key}" (previously set by another plugin)`,
        )
      }
      merged[key] = value
    }
  }

  return merged
}

/**
 * Store merged plugin settings in the synchronous cache.
 * Called after loadAllPlugins resolves.
 */
export function cachePluginSettings(plugins: LoadedPlugin[]): void {
  const settings = mergePluginSettings(plugins)
  setPluginSettingsBase(settings)
  // Only bust the session settings cache if there are actually plugin settings
  // to merge. In the common case (no plugins, or plugins without settings) the
  // base layer is empty and loadSettingsFromDisk would produce the same result
  // anyway — resetting here would waste ~17ms on startup re-reading and
  // re-validating every settings file on the next getSettingsWithErrors() call.
  if (settings && Object.keys(settings).length > 0) {
    resetSettingsCache()
    logForDebugging(
      `Cached plugin settings with keys: ${Object.keys(settings).join(', ')}`,
    )
  }
}

/**
 * Type predicate: check if a value is a non-null, non-array object (i.e., a record).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
