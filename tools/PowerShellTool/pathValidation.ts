/**
 * PowerShell-specific path validation for command arguments.
 *
 * Extracts file paths from PowerShell commands using the AST parser
 * and validates they stay within allowed project directories.
 * Follows the same patterns as BashTool/pathValidation.ts.
 */

import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionRule } from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getFsImplementation,
  safeResolvePath,
} from '../../utils/fsOperations.js'
import { containsPathTraversal, getDirectoryForPath } from '../../utils/path.js'
import {
  allWorkingDirectories,
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  isDangerousRemovalPath,
  isPathInSandboxWriteAllowlist,
} from '../../utils/permissions/pathValidation.js'
import { getPlatform } from '../../utils/platform.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'
import {
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../utils/powershell/parser.js'
import { COMMON_SWITCHES, COMMON_VALUE_PARAMS } from './commonParameters.js'
import { resolveToCanonical } from './readOnlyValidation.js'

const MAX_DIRS_TO_LIST = 5
// PowerShell wildcards are only * ? [ ] — braces are LITERAL characters
// (no brace expansion). Including {} mis-routed paths like `./{x}/passwd`
// through glob-base truncation instead of full-path symlink resolution.
const GLOB_PATTERN_REGEX = /[*?[\]]/

import {
  type FileOperationType,
  type CmdletPathConfig,
  CMDLET_PATH_CONFIG,
} from './pathValidation/cmdletConfig.js'

type PathCheckResult = {
  allowed: boolean
  decisionReason?: import('../../utils/permissions/PermissionResult.js').PermissionDecisionReason
}

type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

/**
 * Checks if a lowercase parameter name (with leading dash) matches any entry
 * in the given param list, accounting for PowerShell's prefix-matching behavior
 * (e.g., -Lit matches -LiteralPath).
 */
function matchesParam(paramLower: string, paramList: string[]): boolean {
  for (const p of paramList) {
    if (
      p === paramLower ||
      (paramLower.length > 1 && p.startsWith(paramLower))
    ) {
      return true
    }
  }
  return false
}

/**
 * Returns true if a colon-syntax value contains expression constructs that
 * mask the real runtime path (arrays, subexpressions, variables, backtick
 * escapes). The outer CommandParameterAst 'Parameter' element type hides
 * these from our AST walk, so we must detect them textually.
 *
 * Used in three branches of extractPathsFromCommand: pathParams,
 * leafOnlyPathParams, and the unknown-param defense-in-depth branch.
 */
function hasComplexColonValue(rawValue: string): boolean {
  return (
    rawValue.includes(',') ||
    rawValue.startsWith('(') ||
    rawValue.startsWith('[') ||
    rawValue.includes('`') ||
    rawValue.includes('@(') ||
    rawValue.startsWith('@{') ||
    rawValue.includes('$')
  )
}

function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length
  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map(dir => `'${dir}'`).join(', ')
  }
  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map(dir => `'${dir}'`)
    .join(', ')
  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`
}

/**
 * Expands tilde (~) at the start of a path to the user's home directory.
 */
function expandTilde(filePath: string): string {
  if (
    filePath === '~' ||
    filePath.startsWith('~/') ||
    filePath.startsWith('~\\')
  ) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

/**
 * Checks the raw user-provided path (pre-realpath) for dangerous removal
 * targets. safeResolvePath/realpathSync canonicalizes in ways that defeat
 * isDangerousRemovalPath: on Windows '/' → 'C:\' (fails the === '/' check);
 * on macOS homedir() may be under /var which realpathSync rewrites to
 * /private/var (fails the === homedir() check). Checking the tilde-expanded,
 * backslash-normalized form catches the dangerous shapes (/, ~, /etc, /usr)
 * as the user typed them.
 */
export function isDangerousRemovalRawPath(filePath: string): boolean {
  const expanded = expandTilde(filePath.replace(/^['"]|['"]$/g, '')).replace(
    /\\/g,
    '/',
  )
  return isDangerousRemovalPath(expanded)
}

export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `Remove-Item on system path '${path}' is blocked. This path is protected from removal.`,
    decisionReason: {
      type: 'other',
      reason: 'Removal targets a protected system path',
    },
  }
}

/**
 * Checks if a resolved path is allowed for the given operation type.
 * Mirrors the logic in BashTool/pathValidation.ts isPathAllowed.
 */
function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. Check deny rules first
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. For write/create operations, check internal editable paths (plan files, scratchpad, agent memory, job dirs)
  // This MUST come before checkPathSafetyForAutoEdit since .claude is a dangerous directory
  // and internal editable paths live under ~/.claude/ — matching the ordering in
  // checkWritePermissionForTool (filesystem.ts step 1.5)
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. For write/create operations, check safety validations
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    )
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }

  // 3. Check if path is in allowed working directory
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
  }

  // 3.5. For read operations, check internal readable paths
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. For write/create operations to paths OUTSIDE the working directory,
  // check the sandbox write allowlist. When the sandbox is enabled, users
  // have explicitly configured writable directories (e.g. /tmp/claude/) —
  // treat these as additional allowed write directories so redirects/Out-File/
  // New-Item don't prompt unnecessarily. Paths IN the working directory are
  // excluded: the sandbox allowlist always seeds '.' (cwd), which would
  // bypass the acceptEdits gate at step 3.
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }

  // 4. Check allow rules
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. Path is not allowed
  return { allowed: false }
}

/**
 * Best-effort deny check for paths obscured by :: or backtick syntax.
 * ONLY checks deny rules — never auto-allows. If the stripped guess
 * doesn't match a deny rule, we fall through to ask as before.
 */
function checkDenyRuleForGuessedPath(
  strippedPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): { resolvedPath: string; rule: PermissionRule } | null {
  // Red-team P7: null bytes make expandPath throw. Pre-existing but
  // defend here since we're introducing a new call path.
  if (!strippedPath || strippedPath.includes('\0')) return null
  // Red-team P3: `~/.ssh/x strips to ~/.ssh/x but expandTilde only fires
  // on leading ~ — the backtick was in front of it. Re-run here.
  const tildeExpanded = expandTilde(strippedPath)
  const abs = isAbsolute(tildeExpanded)
    ? tildeExpanded
    : resolve(cwd, tildeExpanded)
  const { resolvedPath } = safeResolvePath(getFsImplementation(), abs)
  const permissionType = operationType === 'read' ? 'read' : 'edit'
  const denyRule = matchingRuleForInput(
    resolvedPath,
    toolPermissionContext,
    permissionType,
    'deny',
  )
  return denyRule ? { resolvedPath, rule: denyRule } : null
}

/**
 * Validates a file system path, handling tilde expansion.
 */
function validatePath(
  filePath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // Remove surrounding quotes if present
  const cleanPath = expandTilde(filePath.replace(/^['"]|['"]$/g, ''))

  // SECURITY: PowerShell Core normalizes backslashes to forward slashes on all
  // platforms, but path.resolve on Linux/Mac treats them as literal characters.
  // Normalize before resolution so traversal patterns like dir\..\..\etc\shadow
  // are correctly detected.
  const normalizedPath = cleanPath.replace(/\\/g, '/')

  // SECURITY: Backtick (`) is PowerShell's escape character. It is a no-op in
  // many positions (e.g., `/ === /) but defeats Node.js path checks like
  // isAbsolute(). Redirection targets use raw .Extent.Text which preserves
  // backtick escapes. Treat any path containing a backtick as unvalidatable.
  if (normalizedPath.includes('`')) {
    // Red-team P3: backtick is already resolved for StringConstant args
    // (parser uses .value); this guard primarily fires for redirection
    // targets which use raw .Extent.Text. Strip is a no-op for most special
    // escapes (`n → n) but that's fine — wrong guess → no deny match →
    // falls to ask.
    const backtickStripped = normalizedPath.replace(/`/g, '')
    const denyHit = checkDenyRuleForGuessedPath(
      backtickStripped,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Backtick escape characters in paths cannot be statically validated and require manual approval',
      },
    }
  }

  // SECURITY: Block module-qualified provider paths. PowerShell allows
  // `Microsoft.PowerShell.Core\FileSystem::/etc/passwd` which resolves to
  // `/etc/passwd` via the FileSystem provider. The `::` is the provider
  // path separator and doesn't match the simple `^[a-z]{2,}:` regex.
  if (normalizedPath.includes('::')) {
    // Strip everything up to and including the first :: — handles both
    // FileSystem::/path and Microsoft.PowerShell.Core\FileSystem::/path.
    // Double-:: (Foo::Bar::/x) strips first only → 'Bar::/x' → resolve
    // makes it {cwd}/Bar::/x → won't match real deny rules → falls to ask.
    // Safe.
    const afterProvider = normalizedPath.slice(normalizedPath.indexOf('::') + 2)
    const denyHit = checkDenyRuleForGuessedPath(
      afterProvider,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Module-qualified provider paths (::) cannot be statically validated and require manual approval',
      },
    }
  }

  // SECURITY: Block UNC paths — they can trigger network requests and
  // leak NTLM/Kerberos credentials
  if (
    normalizedPath.startsWith('//') ||
    /DavWWWRoot/i.test(normalizedPath) ||
    /@SSL@/i.test(normalizedPath)
  ) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'UNC paths are blocked because they can trigger network requests and credential leakage',
      },
    }
  }

  // SECURITY: Reject paths containing shell expansion syntax
  if (normalizedPath.includes('$') || normalizedPath.includes('%')) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: 'Variable expansion syntax in paths requires manual approval',
      },
    }
  }

  // SECURITY: Block non-filesystem provider paths (env:, HKLM:, alias:, function:, etc.)
  // These paths access non-filesystem resources and must require manual approval.
  // This catches colon-syntax like -Path:env:HOME where the extracted value is 'env:HOME'.
  //
  // Platform split (findings #21/#28):
  // - Windows: require 2+ letters before ':' so native drive letters (C:, D:)
  //   pass through to path.win32.isAbsolute/resolve which handle them correctly.
  // - POSIX: ANY <letters>: prefix is a PowerShell PSDrive — single-letter drive
  //   paths have no native meaning on Linux/macOS. `New-PSDrive -Name Z -Root /etc`
  //   then `Get-Content Z:/secrets` would otherwise resolve via
  //   path.posix.resolve(cwd, 'Z:/secrets') → '{cwd}/Z:/secrets' → inside cwd →
  //   allowed, bypassing Read(/etc/**) deny rules. We cannot statically know what
  //   filesystem root a PSDrive maps to, so treat all drive-prefixed paths on
  //   POSIX as unvalidatable.
  // Include digits in PSDrive name (bug #23): `New-PSDrive -Name 1 ...`
  // creates drive `1:` — a valid PSDrive path prefix.
  // Windows regex requires 2+ chars to exclude single-letter native drive letters
  // (C:, D:). Use a single character class [a-z0-9] to catch mixed alphanumeric
  // PSDrive names like `a1:`, `1a:` — the previous alternation `[a-z]{2,}|[0-9]+`
  // missed those since `a1` is neither pure letters nor pure digits.
  const providerPathRegex =
    getPlatform() === 'windows' ? /^[a-z0-9]{2,}:/i : /^[a-z0-9]+:/i
  if (providerPathRegex.test(normalizedPath)) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: `Path '${normalizedPath}' uses a non-filesystem provider and requires manual approval`,
      },
    }
  }

  // SECURITY: Block glob patterns in write/create operations
  if (GLOB_PATTERN_REGEX.test(normalizedPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: normalizedPath,
        decisionReason: {
          type: 'other',
          reason:
            'Glob patterns are not allowed in write operations. Please specify an exact file path.',
        },
      }
    }

    // For read operations with path traversal (e.g., /project/*/../../../etc/shadow),
    // resolve the full path (including glob chars) and validate that resolved path.
    // This catches patterns that escape the working directory via `..` after the glob.
    if (containsPathTraversal(normalizedPath)) {
      const absolutePath = isAbsolute(normalizedPath)
        ? normalizedPath
        : resolve(cwd, normalizedPath)
      const { resolvedPath, isCanonical } = safeResolvePath(
        getFsImplementation(),
        absolutePath,
      )
      const result = isPathAllowed(
        resolvedPath,
        toolPermissionContext,
        operationType,
        isCanonical ? [resolvedPath] : undefined,
      )
      return {
        allowed: result.allowed,
        resolvedPath,
        decisionReason: result.decisionReason,
      }
    }

    // SECURITY (finding #15): Glob patterns for read operations cannot be
    // statically validated. getGlobBaseDirectory returns the directory before
    // the first glob char; only that base is realpathed. Anything matched by
    // the glob (including symlinks) is never examined. Example:
    //   /project/*/passwd with symlink /project/link → /etc
    // Base dir is /project (allowed), but runtime expands * to 'link' and
    // reads /etc/passwd. We cannot validate symlinks inside glob expansion
    // without actually expanding the glob (requires filesystem access and
    // still races with attacker creating symlinks post-validation).
    //
    // Still check deny rules on the base directory so explicit Read(/project/**)
    // deny rules fire. If no deny matches, force ask.
    const basePath = getGlobBaseDirectory(normalizedPath)
    const absoluteBasePath = isAbsolute(basePath)
      ? basePath
      : resolve(cwd, basePath)
    const { resolvedPath } = safeResolvePath(
      getFsImplementation(),
      absoluteBasePath,
    )
    const permissionType = operationType === 'read' ? 'read' : 'edit'
    const denyRule = matchingRuleForInput(
      resolvedPath,
      toolPermissionContext,
      permissionType,
      'deny',
    )
    if (denyRule !== null) {
      return {
        allowed: false,
        resolvedPath,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }
    return {
      allowed: false,
      resolvedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Glob patterns in paths cannot be statically validated — symlinks inside the glob expansion are not examined. Requires manual approval.',
      },
    }
  }

  // Resolve path
  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(cwd, normalizedPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

function getGlobBaseDirectory(filePath: string): string {
  const globMatch = filePath.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return filePath
  }
  const beforeGlob = filePath.substring(0, globMatch.index)
  const lastSepIndex = Math.max(
    beforeGlob.lastIndexOf('/'),
    beforeGlob.lastIndexOf('\\'),
  )
  if (lastSepIndex === -1) return '.'
  return beforeGlob.substring(0, lastSepIndex + 1) || '/'
}

/**
 * Element types that are safe to extract as literal path strings.
 *
 * Only element types with statically-known string values are safe for path
 * extraction. Variable and ExpandableString have runtime-determined values —
 * even though they're defended downstream ($ detection in validatePath's
 * `includes('$')` check, and the hasExpandableStrings security flag), excluding
 * them here is defense-in-direct: fail-safe at the earliest gate rather than
 * relying on downstream checks to catch them.
 *
 * Any other type (e.g., 'Other' for ArrayLiteralExpressionAst, 'SubExpression',
 * 'ScriptBlock', 'Variable', 'ExpandableString') cannot be statically validated
 * and must force an ask.
 */
const SAFE_PATH_ELEMENT_TYPES = new Set<string>(['StringConstant', 'Parameter'])

/**
 * Extract file paths from a parsed PowerShell command element.
 * Uses the AST args to find positional and named path parameters.
 *
 * If any path argument has a complex elementType (e.g., array literal,
 * subexpression) that cannot be statically validated, sets
 * hasUnvalidatablePathArg so the caller can force an ask.
 */
function extractPathsFromCommand(cmd: ParsedCommandElement): {
  paths: string[]
  operationType: FileOperationType
  hasUnvalidatablePathArg: boolean
  optionalWrite: boolean
} {
  const canonical = resolveToCanonical(cmd.name)
  const config = CMDLET_PATH_CONFIG[canonical]

  if (!config) {
    return {
      paths: [],
      operationType: 'read',
      hasUnvalidatablePathArg: false,
      optionalWrite: false,
    }
  }

  // Build per-cmdlet known-param sets, merging in common parameters.
  const switchParams = [...config.knownSwitches, ...COMMON_SWITCHES]
  const valueParams = [...config.knownValueParams, ...COMMON_VALUE_PARAMS]

  const paths: string[] = []
  const args = cmd.args
  // elementTypes[0] is the command name; elementTypes[i+1] corresponds to args[i]
  const elementTypes = cmd.elementTypes
  let hasUnvalidatablePathArg = false
  let positionalsSeen = 0
  const positionalSkip = config.positionalSkip ?? 0

  function checkArgElementType(argIdx: number): void {
    if (!elementTypes) return
    const et = elementTypes[argIdx + 1]
    if (et && !SAFE_PATH_ELEMENT_TYPES.has(et)) {
      hasUnvalidatablePathArg = true
    }
  }

  // Extract named parameter values (e.g., -Path "C:\foo")
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    // Check if this arg is a parameter name.
    // SECURITY: Use elementTypes as ground truth. PowerShell's tokenizer
    // accepts en-dash/em-dash/horizontal-bar (U+2013/2014/2015) as parameter
    // prefixes; a raw startsWith('-') check misses `–Path` (en-dash). The
    // parser maps CommandParameterAst → 'Parameter' regardless of dash char.
    // isPowerShellParameter also correctly rejects quoted "-Include"
    // (StringConstant, not a parameter).
    const argElementType = elementTypes ? elementTypes[i + 1] : undefined
    if (isPowerShellParameter(arg, argElementType)) {
      // Handle colon syntax: -Path:C:\secret
      // Normalize Unicode dash to ASCII `-` (pathParams are stored with `-`).
      const normalized = '-' + arg.slice(1)
      const colonIdx = normalized.indexOf(':', 1) // skip first char (the dash)
      const paramName =
        colonIdx > 0 ? normalized.substring(0, colonIdx) : normalized
      const paramLower = paramName.toLowerCase()

      if (matchesParam(paramLower, config.pathParams)) {
        // Known path parameter — extract its value as a path.
        let value: string | undefined
        if (colonIdx > 0) {
          // Colon syntax: -Path:value — the whole thing is one element.
          // SECURITY: comma-separated values (e.g., -Path:safe.txt,/etc/passwd)
          // produce ArrayLiteralExpressionAst inside the CommandParameterAst.
          // PowerShell writes to ALL paths, but we see a single string.
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          // Standard syntax: -Path value
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++ // Skip the value
          }
        }
        if (value) {
          paths.push(value)
        }
      } else if (
        config.leafOnlyPathParams &&
        matchesParam(paramLower, config.leafOnlyPathParams)
      ) {
        // Leaf-only path parameter (e.g., New-Item -Name). PowerShell resolves
        // this relative to ANOTHER parameter (-Path), not cwd. validatePath
        // resolves against cwd (L930), so non-leaf values (separators,
        // traversal) resolve to the WRONG location and can miss deny rules
        // (deny→ask downgrade). Extract simple leaf filenames; flag anything
        // path-like.
        let value: string | undefined
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++
          }
        }
        if (value !== undefined) {
          if (
            value.includes('/') ||
            value.includes('\\') ||
            value === '.' ||
            value === '..'
          ) {
            // Non-leaf: separators or traversal. Can't resolve correctly
            // without joining against -Path. Force ask.
            hasUnvalidatablePathArg = true
          } else {
            // Simple leaf: extract. Resolves to cwd/leaf (slightly wrong —
            // should be <-Path>/leaf) but -Path extraction covers the
            // directory, and a leaf filename can't traverse out of anywhere.
            paths.push(value)
          }
        }
      } else if (matchesParam(paramLower, switchParams)) {
        // Known switch parameter — takes no value, do NOT consume next arg.
        // (Colon syntax on a switch, e.g., -Confirm:$false, is self-contained
        // in one token and correctly falls through here without consuming.)
      } else if (matchesParam(paramLower, valueParams)) {
        // Known value-taking non-path parameter (e.g., -Encoding UTF8, -Filter *.txt).
        // Consume its value; do NOT validate as path, but DO check elementType.
        // SECURITY: A Variable elementType (e.g., $env:ANTHROPIC_API_KEY) in any
        // argument position means the runtime value is not statically knowable.
        // Without this check, `-Value $env:SECRET` would be silently auto-allowed
        // in acceptEdits mode because the Variable elementType was never examined.
        if (colonIdx > 0) {
          // Colon syntax: -Value:$env:FOO — the value is embedded in the token.
          // The outer CommandParameterAst 'Parameter' type masks the inner
          // expression type. Check for expression markers that indicate a
          // non-static value (mirrors pathParams colon-syntax guards).
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          }
        } else {
          const nextArg = args[i + 1]
          const nextArgType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextArg && !isPowerShellParameter(nextArg, nextArgType)) {
            checkArgElementType(i + 1)
            i++ // Skip the parameter's value
          }
        }
      } else {
        // Unknown parameter — we do not understand this invocation.
        // SECURITY: This is the structural fix for the KNOWN_SWITCH_PARAMS
        // whack-a-mole. Rather than guess whether this param is a switch
        // (and risk swallowing a positional path) or takes a value (and
        // risk the same), we flag the whole command as unvalidatable.
        // The caller will force an ask.
        hasUnvalidatablePathArg = true
        // SECURITY: Even though we don't recognize this param, if it uses
        // colon syntax (-UnknownParam:/etc/hosts) the bound value might be
        // a filesystem path. Extract it into paths[] so deny-rule matching
        // still runs. Without this, the value is trapped inside the single
        // token and paths=[] means deny rules are never consulted —
        // downgrading deny to ask. This is defense-in-depth: the primary
        // fix is adding all known aliases to pathParams above.
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (!hasComplexColonValue(rawValue)) {
            paths.push(rawValue)
          }
        }
        // Continue the loop so we still extract any recognizable paths
        // (useful for the ask message), but the flag ensures overall 'ask'.
      }
      continue
    }

    // Positional arguments: extract as paths (e.g., Get-Content file.txt)
    // The first positional arg is typically the source path.
    // Skip leading positionals that are non-path values (e.g., iwr's -Uri).
    if (positionalsSeen < positionalSkip) {
      positionalsSeen++
      continue
    }
    positionalsSeen++
    checkArgElementType(i)
    paths.push(arg)
  }

  return {
    paths,
    operationType: config.operationType,
    hasUnvalidatablePathArg,
    optionalWrite: config.optionalWrite ?? false,
  }
}

/**
 * Checks path constraints for PowerShell commands.
 * Extracts file paths from the parsed AST and validates they are
 * within allowed directories.
 *
 * @param compoundCommandHasCd - Whether the full compound command contains a
 *   cwd-changing cmdlet (Set-Location/Push-Location/Pop-Location/New-PSDrive,
 *   excluding no-op Set-Location-to-CWD). When true, relative paths in ANY
 *   statement cannot be trusted — PowerShell executes statements sequentially
 *   and a cd in statement N changes the cwd for statement N+1, but this
 *   validator resolves all paths against the stale Node process cwd.
 *   BashTool parity (BashTool/pathValidation.ts:630-655).
 *
 * @returns
 * - 'ask' if any path command tries to access outside allowed directories
 * - 'deny' if a deny rule explicitly blocks the path
 * - 'passthrough' if no path commands were found or all paths are valid
 */
export function checkPathConstraints(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: 'Cannot validate paths for unparsed command',
    }
  }

  // SECURITY: Two-pass approach — check ALL statements/paths so deny rules
  // always take precedence over ask. Without this, an ask on statement 1
  // could return before checking statement 2 for deny rules, letting the
  // user approve a command that includes a denied path.
  let firstAsk: PermissionResult | undefined

  for (const statement of parsed.statements) {
    const result = checkPathConstraintsForStatement(
      statement,
      toolPermissionContext,
      compoundCommandHasCd,
    )
    if (result.behavior === 'deny') {
      return result
    }
    if (result.behavior === 'ask' && !firstAsk) {
      firstAsk = result
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: 'All path constraints validated successfully',
    }
  )
}

function checkPathConstraintsForStatement(
  statement: ParsedPowerShellCommand['statements'][number],
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  const cwd = getCwd()
  let firstAsk: PermissionResult | undefined

  // SECURITY: BashTool parity — block path operations in compound commands
  // containing a cwd-changing cmdlet (BashTool/pathValidation.ts:630-655).
  //
  // When the compound contains Set-Location/Push-Location/Pop-Location/
  // New-PSDrive, relative paths in later statements resolve against the
  // CHANGED cwd at runtime, but this validator resolves them against the
  // STALE getCwd() snapshot. Example attack (finding #3):
  //   Set-Location ./.claude; Set-Content ./settings.json '...'
  // Validator sees ./settings.json → /project/settings.json (not a config file).
  // Runtime writes /project/.claude/settings.json (Claude's permission config).
  //
  // ALTERNATIVE APPROACH (rejected): simulate cwd through the statement chain
  // — after `Set-Location ./.claude`, validate subsequent statements with
  // cwd='./.claude'. This would be more permissive but requires careful
  // handling of:
  //   - Push-Location/Pop-Location stack semantics
  //   - Set-Location with no args (→ home on some platforms)
  //   - New-PSDrive root mapping (arbitrary filesystem root)
  //   - Conditional/loop statements where cd may or may not execute
  //   - Error cases where the cd target can't be statically determined
  // For now we take the conservative approach of requiring manual approval.
  //
  // Unlike BashTool which gates on `operationType !== 'read'`, we also block
  // READS (finding #27): `Set-Location ~; Get-Content ./.ssh/id_rsa` bypasses
  // Read(~/.ssh/**) deny rules because the validator matched the deny against
  // /project/.ssh/id_rsa. Reads from mis-resolved paths leak data just as
  // writes destroy it. We still run deny-rule matching below (via firstAsk,
  // not early return) so explicit deny rules on the stale-resolved path are
  // honored — deny > ask in the caller's reduce.
  if (compoundCommandHasCd) {
    firstAsk = {
      behavior: 'ask',
      message:
        'Compound command changes working directory (Set-Location/Push-Location/Pop-Location/New-PSDrive) — relative paths cannot be validated against the original cwd and require manual approval',
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with path operation — manual approval required to prevent path resolution bypass',
      },
    }
  }

  // SECURITY: Track whether this statement contains a non-CommandAst pipeline
  // element (string literal, variable, array expression). PowerShell pipes
  // these values to downstream cmdlets, often binding to -Path. Example:
  // `'/etc/passwd' | Remove-Item` — the string is piped to Remove-Item's -Path,
  // but Remove-Item has no explicit args so extractPathsFromCommand returns
  // zero paths and the command would passthrough. If ANY downstream cmdlet
  // appears alongside an expression source, we force an ask — the piped
  // path is unvalidatable regardless of operation type (reads leak data;
  // writes destroy it).
  let hasExpressionPipelineSource = false
  // Track the non-CommandAst element's text for deny-rule guessing (finding #23).
  // `'.git/hooks/pre-commit' | Remove-Item` — path comes via pipeline, paths=[]
  // from extractPathsFromCommand, so the deny loop below never iterates. We
  // feed the pipeline-source text through checkDenyRuleForGuessedPath so
  // explicit Edit(.git/**) deny rules still fire.
  let pipelineSourceText: string | undefined

  for (const cmd of statement.commands) {
    if (cmd.elementType !== 'CommandAst') {
      hasExpressionPipelineSource = true
      pipelineSourceText = cmd.text
      continue
    }

    const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
      extractPathsFromCommand(cmd)

    // SECURITY: Cmdlet receiving piped path from expression source.
    // `'/etc/shadow' | Get-Content` — Get-Content extracts zero paths
    // (no explicit args). The path comes from the pipeline, which we cannot
    // statically validate. Previously exempted reads (`operationType !== 'read'`),
    // but that was a bypass (review comment 2885739292): reads from
    // unvalidatable paths are still a security risk. Ask regardless of op type.
    if (hasExpressionPipelineSource) {
      const canonical = resolveToCanonical(cmd.name)
      // SECURITY (finding #23): Before falling back to ask, check if the
      // pipeline-source text matches a deny rule. `'.git/hooks/pre-commit' |
      // Remove-Item` should DENY (not ask) when Edit(.git/**) is configured.
      // Strip surrounding quotes (string literals are quoted in .text) and
      // feed through the same deny-guess helper used for ::/backtick paths.
      if (pipelineSourceText !== undefined) {
        const stripped = pipelineSourceText.replace(/^['"]|['"]$/g, '')
        const denyHit = checkDenyRuleForGuessedPath(
          stripped,
          cwd,
          toolPermissionContext,
          operationType,
        )
        if (denyHit) {
          return {
            behavior: 'deny',
            message: `${canonical} targeting '${denyHit.resolvedPath}' was blocked by a deny rule`,
            decisionReason: { type: 'rule', rule: denyHit.rule },
          }
        }
      }
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} receives its path from a pipeline expression source that cannot be statically validated and requires manual approval`,
      }
      // Don't continue — fall through to path loop so deny rules on
      // extracted paths are still checked.
    }

    // SECURITY: Array literals, subexpressions, and other complex
    // argument types cannot be statically validated. An array literal
    // like `-Path ./safe.txt, /etc/passwd` produces a single 'Other'
    // element whose combined text may resolve within CWD while
    // PowerShell actually writes to ALL paths in the array.
    if (hasUnvalidatablePathArg) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval`,
      }
      // Don't continue — fall through to path loop so deny rules on
      // extracted paths are still checked.
    }

    // SECURITY: Write cmdlet in CMDLET_PATH_CONFIG that extracted zero paths.
    // Either (a) the cmdlet has no args at all (`Remove-Item` alone —
    // PowerShell will error, but we shouldn't optimistically assume that), or
    // (b) we failed to recognize the path among the args (shouldn't happen
    // with the unknown-param fail-safe, but defense-in-depth). Conservative:
    // write operation with no validated target → ask.
    // Read cmdlets and pop-location (pathParams: []) are exempt.
    // optionalWrite cmdlets (Invoke-WebRequest/Invoke-RestMethod without
    // -OutFile) are ALSO exempt — they only write to disk when a pathParam is
    // present; without one, output goes to the pipeline. The
    // hasUnvalidatablePathArg check above already covers unknown-param cases.
    if (
      operationType !== 'read' &&
      !optionalWrite &&
      paths.length === 0 &&
      CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
    ) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} is a write operation but no target path could be determined; requires manual approval`,
      }
      continue
    }

    // SECURITY: bash-parity hard-deny for removal cmdlets on
    // system-critical paths. BashTool has isDangerousRemovalPath which
    // hard-DENIES `rm /`, `rm ~`, `rm /etc`, etc. regardless of user config.
    // Port: remove-item (and aliases rm/del/ri/rd/rmdir/erase → resolveToCanonical)
    // on a dangerous path → deny (not ask). User cannot approve system32 deletion.
    const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

    for (const filePath of paths) {
      // Hard-deny removal of dangerous system paths (/, ~, /etc, etc.).
      // Check the RAW path (pre-realpath) first: safeResolvePath can
      // canonicalize '/' → 'C:\' (Windows) or '/var/...' → '/private/var/...'
      // (macOS) which defeats isDangerousRemovalPath's string comparisons.
      if (isRemoval && isDangerousRemovalRawPath(filePath)) {
        return dangerousRemovalDeny(filePath)
      }

      const { allowed, resolvedPath, decisionReason } = validatePath(
        filePath,
        cwd,
        toolPermissionContext,
        operationType,
      )

      // Also check the resolved path — catches symlinks that resolve to a
      // protected location.
      if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
        return dangerousRemovalDeny(resolvedPath)
      }

      if (!allowed) {
        const canonical = resolveToCanonical(cmd.name)
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `${canonical} targeting '${resolvedPath}' was blocked. For security, Claude Code may only access files in the allowed working directories for this session: ${dirListStr}.`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        const suggestions: PermissionUpdate[] = []
        if (resolvedPath) {
          if (operationType === 'read') {
            const suggestion = createReadRuleSuggestion(
              getDirectoryForPath(resolvedPath),
              'session',
            )
            if (suggestion) {
              suggestions.push(suggestion)
            }
          } else {
            suggestions.push({
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            })
          }
        }

        if (operationType === 'write' || operationType === 'create') {
          suggestions.push({
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          })
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions,
        }
      }
    }
  }

  // Also check nested commands from control flow
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
        extractPathsFromCommand(cmd)

      if (hasUnvalidatablePathArg) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval`,
        }
        // Don't continue — fall through to path loop for deny checks.
      }

      // SECURITY: Write cmdlet with zero extracted paths (mirrors main loop).
      // optionalWrite cmdlets exempt — see main-loop comment.
      if (
        operationType !== 'read' &&
        !optionalWrite &&
        paths.length === 0 &&
        CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
      ) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} is a write operation but no target path could be determined; requires manual approval`,
        }
        continue
      }

      // SECURITY: bash-parity hard-deny for removal on system-critical
      // paths — mirror the main-loop check above. Without this,
      // `if ($true) { Remove-Item / }` routes through nestedCommands and
      // downgrades deny→ask, letting the user approve root deletion.
      const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

      for (const filePath of paths) {
        // Check the RAW path first (pre-realpath); see main-loop comment.
        if (isRemoval && isDangerousRemovalRawPath(filePath)) {
          return dangerousRemovalDeny(filePath)
        }

        const { allowed, resolvedPath, decisionReason } = validatePath(
          filePath,
          cwd,
          toolPermissionContext,
          operationType,
        )

        if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
          return dangerousRemovalDeny(resolvedPath)
        }

        if (!allowed) {
          const canonical = resolveToCanonical(cmd.name)
          const workingDirs = Array.from(
            allWorkingDirectories(toolPermissionContext),
          )
          const dirListStr = formatDirectoryList(workingDirs)

          const message =
            decisionReason?.type === 'other' ||
            decisionReason?.type === 'safetyCheck'
              ? decisionReason.reason
              : `${canonical} targeting '${resolvedPath}' was blocked. For security, Claude Code may only access files in the allowed working directories for this session: ${dirListStr}.`

          if (decisionReason?.type === 'rule') {
            return {
              behavior: 'deny',
              message,
              decisionReason,
            }
          }

          const suggestions: PermissionUpdate[] = []
          if (resolvedPath) {
            if (operationType === 'read') {
              const suggestion = createReadRuleSuggestion(
                getDirectoryForPath(resolvedPath),
                'session',
              )
              if (suggestion) {
                suggestions.push(suggestion)
              }
            } else {
              suggestions.push({
                type: 'addDirectories',
                directories: [getDirectoryForPath(resolvedPath)],
                destination: 'session',
              })
            }
          }

          if (operationType === 'write' || operationType === 'create') {
            suggestions.push({
              type: 'setMode',
              mode: 'acceptEdits',
              destination: 'session',
            })
          }

          firstAsk ??= {
            behavior: 'ask',
            message,
            blockedPath: resolvedPath,
            decisionReason,
            suggestions,
          }
        }
      }

      // Red-team P11/P14: step 5 at powershellPermissions.ts:970 already
      // catches this via the same synthetic-CommandExpressionAst mechanism —
      // this is belt-and-suspenders so the nested loop doesn't rely on that
      // accident. Placed AFTER the path loop so specific asks (blockedPath,
      // suggestions) win via ??=.
      if (hasExpressionPipelineSource) {
        firstAsk ??= {
          behavior: 'ask',
          message: `${resolveToCanonical(cmd.name)} appears inside a control-flow or chain statement where piped expression sources cannot be statically validated and requires manual approval`,
        }
      }
    }
  }

  // Check redirections on nested commands (e.g., from && / || chains)
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      if (cmd.redirections) {
        for (const redir of cmd.redirections) {
          if (redir.isMerging) continue
          if (!redir.target) continue
          if (isNullRedirectionTarget(redir.target)) continue

          const { allowed, resolvedPath, decisionReason } = validatePath(
            redir.target,
            cwd,
            toolPermissionContext,
            'create',
          )

          if (!allowed) {
            const workingDirs = Array.from(
              allWorkingDirectories(toolPermissionContext),
            )
            const dirListStr = formatDirectoryList(workingDirs)

            const message =
              decisionReason?.type === 'other' ||
              decisionReason?.type === 'safetyCheck'
                ? decisionReason.reason
                : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

            if (decisionReason?.type === 'rule') {
              return {
                behavior: 'deny',
                message,
                decisionReason,
              }
            }

            firstAsk ??= {
              behavior: 'ask',
              message,
              blockedPath: resolvedPath,
              decisionReason,
              suggestions: [
                {
                  type: 'addDirectories',
                  directories: [getDirectoryForPath(resolvedPath)],
                  destination: 'session',
                },
              ],
            }
          }
        }
      }
    }
  }

  // Check file redirections
  if (statement.redirections) {
    for (const redir of statement.redirections) {
      if (redir.isMerging) continue
      if (!redir.target) continue
      if (isNullRedirectionTarget(redir.target)) continue

      const { allowed, resolvedPath, decisionReason } = validatePath(
        redir.target,
        cwd,
        toolPermissionContext,
        'create',
      )

      if (!allowed) {
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions: [
            {
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            },
          ],
        }
      }
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: 'All path constraints validated successfully',
    }
  )
}
