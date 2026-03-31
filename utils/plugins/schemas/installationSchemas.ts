/**
 * Plugin installation state schemas.
 *
 * Defines schemas for plugin IDs, dependency references, settings entries,
 * installed plugin metadata, installation scopes, and the installed_plugins.json
 * file format (V1 and V2).
 *
 * Extracted from utils/plugins/schemas.ts for modularity.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../lazySchema.js'

/**
 * Schema for plugin ID format
 *
 * Plugin IDs follow the format: "plugin-name@marketplace-name"
 * Both parts allow alphanumeric characters, hyphens, dots, and underscores.
 *
 * Examples:
 * - "code-formatter@anthropic-tools"
 * - "db_assistant@company-internal"
 * - "my.plugin@personal-marketplace"
 */
export const PluginIdSchema = lazySchema(() =>
  z
    .string()
    .regex(
      /^[a-z0-9][-a-z0-9._]*@[a-z0-9][-a-z0-9._]*$/i,
      'Plugin ID must be in format: plugin@marketplace',
    ),
)

const DEP_REF_REGEX =
  /^[a-z0-9][-a-z0-9._]*(@[a-z0-9][-a-z0-9._]*)?(@\^[^@]*)?$/i

/**
 * Schema for entries in a plugin's `dependencies` array.
 *
 * Accepts three forms, all normalized to a plain "name" or "name@mkt" string
 * by the transform — downstream code (qualifyDependency, resolveDependencyClosure,
 * verifyAndDemote) never sees versions or objects:
 *
 *   "plugin"                → bare, resolved against declaring plugin's marketplace
 *   "plugin@marketplace"    → qualified
 *   "plugin@mkt@^1.2"       → trailing @^version silently stripped (forwards-compat)
 *   {name, marketplace?, …} → object form, version etc. stripped (forwards-compat)
 *
 * The latter two are permitted-but-ignored so future clients adding version
 * constraints don't cause old clients to fail schema validation and reject
 * the whole plugin. See CC-993 for the eventual version-range design.
 */
export const DependencyRefSchema = lazySchema(() =>
  z.union([
    z
      .string()
      .regex(
        DEP_REF_REGEX,
        'Dependency must be a plugin name, optionally qualified with @marketplace',
      )
      .transform(s => s.replace(/@\^[^@]*$/, '')),
    z
      .object({
        name: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i),
        marketplace: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i)
          .optional(),
      })
      .loose()
      .transform(o => (o.marketplace ? `${o.name}@${o.marketplace}` : o.name)),
  ]),
)

/**
 * Schema for plugin reference in settings (repo or user level)
 *
 * Can be either:
 * - Simple string: "plugin-name@marketplace-name"
 * - Object with additional configuration
 *
 * The plugin source (npm, git, local) is defined in the marketplace entry itself,
 * not in the plugin reference.
 *
 * Examples:
 * - "code-formatter@anthropic-tools"
 * - "db-assistant@company-internal"
 * - { id: "formatter@tools", version: "^2.0.0", required: true }
 */
export const SettingsPluginEntrySchema = lazySchema(() =>
  z.union([
    // Simple format: "plugin@marketplace"
    PluginIdSchema(),
    // Extended format with configuration
    z.object({
      id: PluginIdSchema().describe(
        'Plugin identifier (e.g., "formatter@tools")',
      ),
      version: z
        .string()
        .optional()
        .describe('Version constraint (e.g., "^2.0.0")'),
      required: z.boolean().optional().describe('If true, cannot be disabled'),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Plugin-specific configuration'),
    }),
  ]),
)

/**
 * Schema for installed plugin metadata (V1 format)
 *
 * Tracks the actual installation state of a plugin. All plugins are
 * installed from marketplaces, which contain the actual source details
 * (npm, git, local, etc.). The plugin ID is the key in the plugins record,
 * so it's not duplicated here.
 *
 * Example entry for key "code-formatter@anthropic-tools":
 * {
 *   "version": "1.2.0",
 *   "installedAt": "2024-01-15T10:30:00Z",
 *   "marketplace": "anthropic-tools",
 *   "installPath": "/home/user/.claude/plugins/installed/anthropic-tools/code-formatter"
 * }
 */
export const InstalledPluginSchema = lazySchema(() =>
  z.object({
    version: z.string().describe('Currently installed version'),
    installedAt: z.string().describe('ISO 8601 timestamp of installation'),
    lastUpdated: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of last update'),
    installPath: z
      .string()
      .describe('Absolute path to the installed plugin directory'),
    gitCommitSha: z
      .string()
      .optional()
      .describe('Git commit SHA for git-based plugins (for version tracking)'),
  }),
)

/**
 * Schema for the installed_plugins.json file (V1 format)
 *
 * Contains a version number and maps plugin IDs to their installation metadata.
 * Maintained automatically by Claude Code, not edited by users.
 *
 * The version field tracks schema changes. When the version doesn't match
 * the current schema version, Claude Code will update the file on next startup.
 *
 * Example file:
 * {
 *   "version": 1,
 *   "plugins": {
 *     "code-formatter@anthropic-tools": { ... },
 *     "db-assistant@company-internal": { ... }
 *   }
 * }
 */
export const InstalledPluginsFileSchemaV1 = lazySchema(() =>
  z.object({
    version: z.literal(1).describe('Schema version 1'),
    plugins: z
      .record(
        PluginIdSchema(), // Validated plugin ID key (e.g., "formatter@tools")
        InstalledPluginSchema(),
      )
      .describe('Map of plugin IDs to their installation metadata'),
  }),
)

/**
 * Scope types for plugin installation (V2)
 *
 * Plugins can be installed at different scopes:
 * - managed: Enterprise/system-wide (read-only, platform-specific paths)
 * - user: User's global settings (~/.claude/settings.json)
 * - project: Shared project settings ($project/.claude/settings.json)
 * - local: Personal project overrides ($project/.claude/settings.local.json)
 *
 * Note: 'flag' scope plugins (from --settings) are session-only and
 * are NOT persisted to installed_plugins.json.
 */
export const PluginScopeSchema = lazySchema(() =>
  z.enum(['managed', 'user', 'project', 'local']),
)

/**
 * Schema for a single plugin installation entry (V2)
 *
 * Each plugin can have multiple installations at different scopes.
 * For example, the same plugin could be installed at user scope with v1.0
 * and at project scope with v1.1.
 */
export const PluginInstallationEntrySchema = lazySchema(() =>
  z.object({
    scope: PluginScopeSchema().describe('Installation scope'),
    projectPath: z
      .string()
      .optional()
      .describe('Project path (required for project/local scopes)'),
    installPath: z
      .string()
      .describe('Absolute path to the versioned plugin directory'),
    // Preserved from V1:
    version: z.string().optional().describe('Currently installed version'),
    installedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of installation'),
    lastUpdated: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of last update'),
    gitCommitSha: z
      .string()
      .optional()
      .describe('Git commit SHA for git-based plugins'),
  }),
)

/**
 * Schema for the installed_plugins.json file (V2 format)
 *
 * V2 changes from V1:
 * - Each plugin ID maps to an ARRAY of installations (one per scope)
 * - Supports multi-scope installation (same plugin at different scopes/versions)
 *
 * Example file:
 * {
 *   "version": 2,
 *   "plugins": {
 *     "code-formatter@anthropic-tools": [
 *       { "scope": "user", "installPath": "...", "version": "1.0.0" },
 *       { "scope": "project", "projectPath": "/path/to/project", "installPath": "...", "version": "1.1.0" }
 *     ]
 *   }
 * }
 */
export const InstalledPluginsFileSchemaV2 = lazySchema(() =>
  z.object({
    version: z.literal(2).describe('Schema version 2'),
    plugins: z
      .record(PluginIdSchema(), z.array(PluginInstallationEntrySchema()))
      .describe('Map of plugin IDs to arrays of installation entries'),
  }),
)

/**
 * Combined schema that accepts both V1 and V2 formats
 * Used for reading existing files before migration
 */
export const InstalledPluginsFileSchema = lazySchema(() =>
  z.union([InstalledPluginsFileSchemaV1(), InstalledPluginsFileSchemaV2()]),
)

// Inferred types from schemas
export type PluginId = z.infer<ReturnType<typeof PluginIdSchema>> // string in "plugin@marketplace" format
export type InstalledPlugin = z.infer<ReturnType<typeof InstalledPluginSchema>>
export type InstalledPluginsFileV1 = z.infer<
  ReturnType<typeof InstalledPluginsFileSchemaV1>
>
export type InstalledPluginsFileV2 = z.infer<
  ReturnType<typeof InstalledPluginsFileSchemaV2>
>
export type PluginScope = z.infer<ReturnType<typeof PluginScopeSchema>>
export type PluginInstallationEntry = z.infer<
  ReturnType<typeof PluginInstallationEntrySchema>
>
