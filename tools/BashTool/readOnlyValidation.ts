import type { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  containsVulnerableUncPath,
  EXTERNAL_READONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import type { BashTool } from './BashTool.js'
import { isNormalizedGitCommand } from './bashPermissions.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import {
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
  type PathCommand,
} from './pathValidation.js'

import {
  type CommandConfig,
  COMMAND_ALLOWLIST,
  ANT_ONLY_COMMAND_ALLOWLIST,
} from './readOnlyValidation/commandAllowlist.js'


function getCommandAllowlist(): Record<string, CommandConfig> {
  let allowlist: Record<string, CommandConfig> = COMMAND_ALLOWLIST
  // On Windows, xargs can be used as a data-to-code bridge: if a file contains
  // a UNC path, `cat file | xargs cat` feeds that path to cat, triggering SMB
  // resolution. Since the UNC path is in file contents (not the command string),
  // regex-based detection cannot catch this.
  if (getPlatform() === 'windows') {
    const { xargs: _, ...rest } = allowlist
    allowlist = rest
  }
  if (process.env.USER_TYPE === 'ant') {
    return { ...allowlist, ...ANT_ONLY_COMMAND_ALLOWLIST }
  }
  return allowlist
}

/**
 * Commands that are safe to use as xargs targets for auto-approval.
 *
 * SECURITY: Only add a command to this list if it has NO flags that can:
 * 1. Write to files (e.g., find's -fprint, sed's -i)
 * 2. Execute code (e.g., find's -exec, awk's system(), perl's -e)
 * 3. Make network requests
 *
 * These commands must be purely read-only utilities. When xargs uses one of
 * these as a target, we stop validating flags after the target command
 * (see the `break` in isCommandSafeViaFlagParsing), so the command itself
 * must not have ANY dangerous flags, not just a safe subset.
 *
 * Each command was verified by checking its man page for dangerous capabilities.
 */
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo', // Output only, no dangerous flags
  'printf', // xargs runs /usr/bin/printf (binary), not bash builtin — no -v support
  'wc', // Read-only counting, no dangerous flags
  'grep', // Read-only search, no dangerous flags
  'head', // Read-only, no dangerous flags
  'tail', // Read-only (including -f follow), no dangerous flags
]

/**
 * Unified command validation function that replaces individual validator functions.
 * Uses declarative configuration from COMMAND_ALLOWLIST to validate commands and their flags.
 * Handles combined flags, argument validation, and shell quoting bypass detection.
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  // Parse the command to get individual tokens using shell-quote for accuracy
  // Handle glob operators by converting them to strings, they don't matter from the perspective
  // of this function
  const parseResult = tryParseShellCommand(command, env => `$${env}`)
  if (!parseResult.success) return false

  const parsed = parseResult.tokens.map(token => {
    if (typeof token !== 'string') {
      token = token as { op: 'glob'; pattern: string }
      if (token.op === 'glob') {
        return token.pattern
      }
    }
    return token
  })

  // If there are operators (pipes, redirects, etc.), it's not a simple command.
  // Breaking commands down into their constituent parts is handled upstream of
  // this function, so we reject anything with operators here.
  const hasOperators = parsed.some(token => typeof token !== 'string')
  if (hasOperators) {
    return false
  }

  // Now we know all tokens are strings
  const tokens = parsed as string[]

  if (tokens.length === 0) {
    return false
  }

  // Find matching command configuration
  let commandConfig: CommandConfig | undefined
  let commandTokens: number = 0

  // Check for multi-word commands first (e.g., "git diff", "git stash list")
  const allowlist = getCommandAllowlist()
  for (const [cmdPattern] of Object.entries(allowlist)) {
    const cmdTokens = cmdPattern.split(' ')
    if (tokens.length >= cmdTokens.length) {
      let matches = true
      for (let i = 0; i < cmdTokens.length; i++) {
        if (tokens[i] !== cmdTokens[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        commandConfig = allowlist[cmdPattern]
        commandTokens = cmdTokens.length
        break
      }
    }
  }

  if (!commandConfig) {
    return false // Command not in allowlist
  }

  // Special handling for git ls-remote to reject URLs that could lead to data exfiltration
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    // Check if any argument looks like a URL or remote specification
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]
      if (token && !token.startsWith('-')) {
        // Reject HTTP/HTTPS URLs
        if (token.includes('://')) {
          return false
        }
        // Reject SSH URLs like git@github.com:user/repo.git
        if (token.includes('@') || token.includes(':')) {
          return false
        }
        // Reject variable references
        if (token.includes('$')) {
          return false
        }
      }
    }
  }

  // SECURITY: Reject ANY token containing `$` (variable expansion). The
  // `env => \`$${env}\`` callback at line 825 preserves `$VAR` as LITERAL TEXT
  // in tokens, but bash expands it at runtime (unset vars → empty string).
  // This parser differential defeats BOTH validateFlags and callbacks:
  //
  //   (1) `$VAR`-prefix defeats validateFlags `startsWith('-')` check:
  //       `git diff "$Z--output=/tmp/pwned"` → token `$Z--output=/tmp/pwned`
  //       (starts with `$`) falls through as positional at ~:1730. Bash runs
  //       `git diff --output=/tmp/pwned`. ARBITRARY FILE WRITE, zero perms.
  //
  //   (2) `$VAR`-prefix → RCE via `rg --pre`:
  //       `rg . "$Z--pre=bash" FILE` → executes `bash FILE`. rg's config has
  //       no regex and no callback. SINGLE-STEP ARBITRARY CODE EXECUTION.
  //
  //   (3) `$VAR`-infix defeats additionalCommandIsDangerousCallback regex:
  //       `ps ax"$Z"e` → token `ax$Ze`. The ps callback regex
  //       `/^[a-zA-Z]*e[a-zA-Z]*$/` fails on `$` → "not dangerous". Bash runs
  //       `ps axe` → env vars for all processes. A fix limited to `$`-PREFIXED
  //       tokens would NOT close this.
  //
  // We check ALL tokens after the command prefix. Any `$` means we cannot
  // determine the runtime token value, so we cannot verify read-only safety.
  // This check must run BEFORE validateFlags and BEFORE callbacks.
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    // Reject any token containing $ (variable expansion)
    if (token.includes('$')) {
      return false
    }
    // Reject tokens with BOTH `{` and `,` (brace expansion obfuscation).
    // `git diff {@'{'0},--output=/tmp/pwned}` → shell-quote strips quotes
    // → token `{@{0},--output=/tmp/pwned}` has `{` + `,` → brace expansion.
    // This is defense-in-depth with validateBraceExpansion in bashSecurity.ts.
    // We require BOTH `{` and `,` to avoid false positives on legitimate
    // patterns: `stash@{0}` (git ref, has `{` no `,`), `{{.State}}` (Go
    // template, no `,`), `prefix-{}-suffix` (xargs, no `,`). Sequence form
    // `{1..5}` also needs checking (has `{` + `..`).
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return false
    }
  }

  // Validate flags starting after the command tokens
  if (
    !validateFlags(tokens, commandTokens, commandConfig, {
      commandName: tokens[0],
      rawCommand: command,
      xargsTargetCommands:
        tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
    })
  ) {
    return false
  }

  if (commandConfig.regex && !commandConfig.regex.test(command)) {
    return false
  }
  if (!commandConfig.regex && /`/.test(command)) {
    return false
  }
  // Block newlines and carriage returns in grep/rg patterns as they can be used for injection
  if (
    !commandConfig.regex &&
    (tokens[0] === 'rg' || tokens[0] === 'grep') &&
    /[\n\r]/.test(command)
  ) {
    return false
  }
  if (
    commandConfig.additionalCommandIsDangerousCallback &&
    commandConfig.additionalCommandIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return false
  }

  return true
}

/**
 * Creates a regex pattern that matches safe invocations of a command.
 *
 * The regex ensures commands are invoked safely by blocking:
 * - Shell metacharacters that could lead to command injection or redirection
 * - Command substitution via backticks or $()
 * - Variable expansion that could contain malicious payloads
 * - Environment variable assignment bypasses (command=value)
 *
 * @param command The command name (e.g., 'date', 'npm list', 'ip addr')
 * @returns RegExp that matches safe invocations of the command
 */
function makeRegexForSafeCommand(command: string): RegExp {
  // Create regex pattern: /^command(?:\s|$)[^<>()$`|{}&;\n\r]*$/
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

// Simple commands that are safe for execution (converted to regex patterns using makeRegexForSafeCommand)
// WARNING: If you are adding new commands here, be very careful to ensure
// they are truly safe. This includes ensuring:
// 1. That they don't have any flags that allow file writing or command execution
// 2. Use makeRegexForSafeCommand() to ensure proper regex pattern creation
const READONLY_COMMANDS = [
  // Cross-platform commands from shared validation
  ...EXTERNAL_READONLY_COMMANDS,

  // Unix/bash-specific read-only commands (not shared because they don't exist in PowerShell)

  // Time and date
  'cal',
  'uptime',

  // File content viewing (relative paths handled separately)
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',

  // System info
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',

  // Path information
  'basename',
  'dirname',
  'realpath',

  // Text processing
  'cut',
  'paste',
  'tr',
  'column',
  'tac', // Reverse cat — displays file contents in reverse line order
  'rev', // Reverse characters in each line
  'fold', // Wrap lines to specified width
  'expand', // Convert tabs to spaces
  'unexpand', // Convert spaces to tabs
  'fmt', // Simple text formatter — output to stdout only
  'comm', // Compare sorted files line by line
  'cmp', // Byte-by-byte file comparison
  'numfmt', // Number format conversion

  // Path information (additional)
  'readlink', // Resolve symlinks — displays target of symbolic link

  // File comparison
  'diff',

  // true and false, used to silence or create errors
  'true',
  'false',

  // Misc. safe commands
  'sleep',
  'which',
  'type',
  'expr', // Evaluate expressions (arithmetic, string matching)
  'test', // Conditional evaluation (file checks, comparisons)
  'getconf', // Get system configuration values
  'seq', // Generate number sequences
  'tsort', // Topological sort
  'pr', // Paginate files for printing
]

// Complex commands that require custom regex patterns
// Warning: If possible, avoid adding new regexes here and prefer using COMMAND_ALLOWLIST
// instead. This allowlist-based approach to CLI flags is more secure and avoids
// vulns coming from gnu getopt_long.
const READONLY_COMMAND_REGEXES = new Set([
  // Convert simple commands to regex patterns using makeRegexForSafeCommand
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),

  // Echo that doesn't execute commands or use variables
  // Allow newlines in single quotes (safe) but not in double quotes (could be dangerous with variable expansion)
  // Also allow optional 2>&1 stderr redirection at the end
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

  // Claude CLI help
  /^claude -h$/,
  /^claude --help$/,

  // Git readonly commands are now handled via COMMAND_ALLOWLIST with explicit flag validation
  // (git status, git blame, git ls-files, git config --get, git remote, git tag, git branch)

  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // Only allow flags, no input/output files

  // System info
  /^pwd$/,
  /^whoami$/,
  // env and printenv removed - could expose sensitive environment variables

  // Development tools version checking - exact match only, no suffix allowed.
  // SECURITY: `node -v --run <task>` would execute package.json scripts because
  // Node processes --run before -v. Python/python3 --version are also anchored
  // for defense-in-depth. These were previously in EXTERNAL_READONLY_COMMANDS which
  // flows through makeRegexForSafeCommand and permits arbitrary suffixes.
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,

  // Misc. safe commands
  // tree command moved to COMMAND_ALLOWLIST for proper flag validation (blocks -o/--output)
  /^history(?:\s+\d+)?\s*$/, // Only allow bare history or history with numeric argument - prevents file writing
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/, // Only allow arch with help flags or no arguments

  // Network commands - only allow exact commands with no arguments to prevent network manipulation
  /^ip addr$/, // Only allow "ip addr" with no additional arguments
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/, // Allow ifconfig with interface name only (must start with letter)

  // JSON processing with jq - allow with inline filters and file arguments
  // File arguments are validated separately by pathValidation.ts
  // Allow pipes and complex expressions within quotes but prevent dangerous flags
  // Block command substitution - backticks are dangerous even in single quotes for jq
  // Block -f/--from-file, --rawfile, --slurpfile (read files into jq), --run-tests, -L/--library-path (load executable modules)
  // Block 'env' builtin and '$ENV' object which can access environment variables (defense in depth)
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

  // Path commands (path validation ensures they're allowed)
  // cd command - allows changing to directories
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  // ls command - allows listing directories
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  // find command - blocks dangerous flags
  // Allow escaped parentheses \( and \) for grouping, but block unescaped ones
  // NOTE: \\[()] must come BEFORE the character class to ensure \( is matched as an escaped paren,
  // not as backslash + paren (which would fail since paren is excluded from the character class)
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])

/**
 * Checks if a command contains glob characters (?, *, [, ]) or expandable `$`
 * variables OUTSIDE the quote contexts where bash would treat them as literal.
 * These could expand to bypass our regex-based security checks.
 *
 * Glob examples:
 * - `python *` could expand to `python --help` if a file named `--help` exists
 * - `find ./ -?xec` could expand to `find ./ -exec` if such a file exists
 * Globs are literal inside BOTH single and double quotes.
 *
 * Variable expansion examples:
 * - `uniq --skip-chars=0$_` → `$_` expands to last arg of previous command;
 *   with IFS word splitting, this smuggles positional args past "flags-only"
 *   regexes. `echo " /etc/passwd /tmp/x"; uniq --skip-chars=0$_` → FILE WRITE.
 * - `cd "$HOME"` → double-quoted `$HOME` expands at runtime.
 * Variables are literal ONLY inside single quotes; they expand inside double
 * quotes and unquoted.
 *
 * The `$` check guards the READONLY_COMMAND_REGEXES fallback path. The `$`
 * token check in isCommandSafeViaFlagParsing only covers COMMAND_ALLOWLIST
 * commands; hand-written regexes like uniq's `\S+` and cd's `"[^"]*"` allow `$`.
 * Matches `$` followed by `[A-Za-z_@*#?!$0-9-]` covering `$VAR`, `$_`, `$@`,
 * `$*`, `$#`, `$?`, `$!`, `$$`, `$-`, `$0`-`$9`. Does NOT match `${` or `$(` —
 * those are caught by COMMAND_SUBSTITUTION_PATTERNS in bashSecurity.ts.
 *
 * @param command The command string to check
 * @returns true if the command contains unquoted glob or expandable `$`
 */
function containsUnquotedExpansion(command: string): boolean {
  // Track quote state to avoid false positives for patterns inside quoted strings
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // Handle escape sequences
    if (escaped) {
      escaped = false
      continue
    }

    // SECURITY: Only treat backslash as escape OUTSIDE single quotes. In bash,
    // `\` inside `'...'` is LITERAL — it does not escape the next character.
    // Without this guard, `'\'` desyncs the quote tracker: the `\` sets
    // escaped=true, then the closing `'` is consumed by the escaped-skip
    // instead of toggling inSingleQuote. Parser stays in single-quote
    // mode for the rest of the command, missing ALL subsequent expansions.
    // Example: `ls '\' *` — bash sees glob `*`, but desynced parser thinks
    // `*` is inside quotes → returns false (glob NOT detected).
    // Defense-in-depth: hasShellQuoteSingleQuoteBug catches `'\'` patterns
    // before this function is reached, but we fix the tracker anyway for
    // consistency with the correct implementations in bashSecurity.ts.
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    // Update quote state
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // Inside single quotes: everything is literal. Skip.
    if (inSingleQuote) {
      continue
    }

    // Check `$` followed by variable-name or special-parameter character.
    // `$` expands inside double quotes AND unquoted (only SQ makes it literal).
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    // Globs are literal inside double quotes too. Only check unquoted.
    if (inDoubleQuote) {
      continue
    }

    // Check for glob characters outside all quotes.
    // These could expand to anything, including dangerous flags.
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  return false
}

/**
 * Checks if a single command string is read-only based on READONLY_COMMAND_REGEXES.
 * Internal helper function that validates individual commands.
 *
 * @param command The command string to check
 * @returns true if the command is read-only
 */
function isCommandReadOnly(command: string): boolean {
  // Handle common stderr-to-stdout redirection pattern
  // This handles both "command 2>&1" at the end of a full command
  // and "command 2>&1" as part of a pipeline component
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    // Remove the stderr redirection for pattern matching
    testCommand = testCommand.slice(0, -5).trim()
  }

  // Check for Windows UNC paths that could be vulnerable to WebDAV attacks
  // Do this early to prevent any command with UNC paths from being marked as read-only
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }

  // Check for unquoted glob characters and expandable `$` variables that could
  // bypass our regex-based security checks. We can't know what these expand to
  // at runtime, so we can't verify the command is read-only.
  //
  // Globs: `python *` could expand to `python --help` if such a file exists.
  //
  // Variables: `uniq --skip-chars=0$_` — bash expands `$_` at runtime to the
  // last arg of the previous command. With IFS word splitting, this smuggles
  // positional args past "flags-only" regexes like uniq's `\S+`. The `$` token
  // check inside isCommandSafeViaFlagParsing only covers COMMAND_ALLOWLIST
  // commands; hand-written regexes in READONLY_COMMAND_REGEXES (uniq, jq, cd)
  // have no such guard. See containsUnquotedExpansion for full analysis.
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }

  // Tools like git allow `--upload-pack=cmd` to be abbreviated as `--up=cmd`
  // Regex filters can be bypassed, so we use strict allowlist validation instead.
  // This requires defining a set of known safe flags. Claude can help with this,
  // but please look over it to ensure it didn't add any flags that allow file writes
  // code execution, or network requests.
  if (isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }

  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      // Prevent git commands with -c flag to avoid config options that can lead to code execution
      // The -c flag allows setting arbitrary git config values inline, including dangerous ones like
      // core.fsmonitor, diff.external, core.gitProxy, etc. that can execute arbitrary commands
      // Check for -c preceded by whitespace and followed by whitespace or equals
      // Using regex to catch spaces, tabs, and other whitespace (not part of other flags like --cached)
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }

      // Prevent git commands with --exec-path flag to avoid path manipulation that can lead to code execution
      // The --exec-path flag allows overriding the directory where git looks for executables
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }

      // Prevent git commands with --config-env flag to avoid config injection via environment variables
      // The --config-env flag allows setting git config values from environment variables, which can be
      // just as dangerous as -c flag (e.g., core.fsmonitor, diff.external, core.gitProxy)
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  return false
}

/**
 * Checks if a compound command contains any git command.
 *
 * @param command The full command string to check
 * @returns true if any subcommand is a git command
 */
function commandHasAnyGit(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedGitCommand(subcmd.trim()),
  )
}

/**
 * Git-internal path patterns that can be exploited for sandbox escape.
 * If a command creates these files and then runs git, the git command
 * could execute malicious hooks from the created files.
 */
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]

/**
 * Checks if a path is a git-internal path (HEAD, objects/, refs/, hooks/).
 */
function isGitInternalPath(path: string): boolean {
  // Normalize path by removing leading ./ or /
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

// Commands that only delete or modify in-place (don't create new files at new paths)
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])

/**
 * Extracts write paths from a subcommand using PATH_EXTRACTORS.
 * Only returns paths for commands that can create new files/directories
 * (write/create operations excluding deletion and in-place modification).
 */
function extractWritePathsFromSubcommand(subcommand: string): string[] {
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []

  const tokens = parseResult.tokens.filter(
    (t): t is string => typeof t === 'string',
  )
  if (tokens.length === 0) return []

  const baseCmd = tokens[0]
  if (!baseCmd) return []

  // Only consider commands that can create files at target paths
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }

  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand]
  if (!extractor) return []

  return extractor(tokens.slice(1))
}

/**
 * Checks if a compound command writes to any git-internal paths.
 * This is used to detect potential sandbox escape attacks where a command
 * creates git-internal files (HEAD, objects/, refs/, hooks/) and then runs git.
 *
 * SECURITY: A compound command could bypass the bare repo detection by:
 * 1. Creating bare git repo files (HEAD, objects/, refs/, hooks/) in the same command
 * 2. Then running git, which would execute malicious hooks
 *
 * Example attack:
 * mkdir -p objects refs hooks && echo '#!/bin/bash\nmalicious' > hooks/pre-commit && touch HEAD && git status
 *
 * @param command The full command string to check
 * @returns true if any subcommand writes to git-internal paths
 */
function commandWritesToGitInternalPaths(command: string): boolean {
  const subcommands = splitCommand_DEPRECATED(command)

  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()

    // Check write paths from path-based commands (mkdir, touch, cp, mv)
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }

    // Check output redirections (e.g., echo x > hooks/pre-commit)
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }

  return false
}

/**
 * Checks read-only constraints for bash commands.
 * This is the single exported function that validates whether a command is read-only.
 * It handles compound commands, sandbox mode, and safety checks.
 *
 * @param input The bash command input to validate
 * @param compoundCommandHasCd Pre-computed flag indicating if any cd command exists in the compound command.
 *                              This is computed by commandHasAnyCd() and passed in to avoid duplicate computation.
 * @returns PermissionResult indicating whether the command is read-only
 */
export function checkReadOnlyConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const { command } = input

  // Detect if the command is not parseable and return early
  const result = tryParseShellCommand(command, env => `$${env}`)
  if (!result.success) {
    return {
      behavior: 'passthrough',
      message: 'Command cannot be parsed, requires further permission checks',
    }
  }

  // Check the original command for safety before splitting
  // This is important because splitCommand_DEPRECATED may transform the command
  // (e.g., ${VAR} becomes $VAR)
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return {
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    }
  }

  // Check for Windows UNC paths in the original command before transformation
  // This must be done before splitCommand_DEPRECATED because splitCommand_DEPRECATED may transform backslashes
  if (containsVulnerableUncPath(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    }
  }

  // Check once if any subcommand is a git command (used for multiple security checks below)
  const hasGitCommand = commandHasAnyGit(command)

  // SECURITY: Block compound commands that have both cd AND git
  // This prevents sandbox escape via: cd /malicious/dir && git status
  // where the malicious directory contains fake git hooks that execute arbitrary code.
  if (compoundCommandHasCd && hasGitCommand) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    }
  }

  // SECURITY: Block git commands if the current directory looks like a bare/exploited git repo
  // This prevents sandbox escape when an attacker has:
  // 1. Deleted .git/HEAD to invalidate the normal git directory
  // 2. Created hooks/pre-commit or other git-internal files in the current directory
  // Git would then treat the cwd as the git directory and execute malicious hooks.
  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands in directories with bare repository structure require permission checks for enhanced security',
    }
  }

  // SECURITY: Block compound commands that write to git-internal paths AND run git
  // This prevents sandbox escape where a command creates git-internal files
  // (HEAD, objects/, refs/, hooks/) and then runs git, which would execute
  // malicious hooks from the newly created files.
  // Example attack: mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status
  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    }
  }

  // SECURITY: Only auto-allow git commands as read-only if we're in the original cwd
  // (which is protected by sandbox denyWrite) or if sandbox is disabled (attack is moot).
  // Race condition: a sandboxed command can create bare repo files in a subdirectory,
  // and a backgrounded git command (e.g. sleep 10 && git status) would pass the
  // isCurrentDirectoryBareGitRepo() check at evaluation time before the files exist.
  if (
    hasGitCommand &&
    SandboxManager.isSandboxingEnabled() &&
    getCwd() !== getOriginalCwd()
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands outside the original working directory require permission checks when sandbox is enabled',
    }
  }

  // Check if all subcommands are read-only
  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(
    subcmd => {
      if (bashCommandIsSafe_DEPRECATED(subcmd).behavior !== 'passthrough') {
        return false
      }
      return isCommandReadOnly(subcmd)
    },
  )

  if (allSubcommandsReadOnly) {
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }

  // If not read-only, return passthrough to let other permission checks handle it
  return {
    behavior: 'passthrough',
    message: 'Command is not read-only, requires further permission checks',
  }
}
