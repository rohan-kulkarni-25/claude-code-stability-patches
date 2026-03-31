/**
 * Shared command validation maps for shell tools (BashTool, PowerShellTool, etc.).
 *
 * Exports complete command configuration maps that any shell tool can import:
 * - GIT_READ_ONLY_COMMANDS: all git subcommands with safe flags and callbacks
 * - GH_READ_ONLY_COMMANDS: ant-only gh CLI commands (network-dependent)
 * - EXTERNAL_READONLY_COMMANDS: cross-shell commands that work in both bash and PowerShell
 * - containsVulnerableUncPath: UNC path detection for credential leak prevention
 * - outputLimits are in outputLimits.ts
 */

import { getPlatform } from '../platform.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlagArgType =
  | 'none' // No argument (--color, -n)
  | 'number' // Integer argument (--context=3)
  | 'string' // Any string argument (--relative=path)
  | 'char' // Single character (delimiter)
  | '{}' // Literal "{}" only
  | 'EOF' // Literal "EOF" only

export type ExternalCommandConfig = {
  safeFlags: Record<string, FlagArgType>
  // Returns true if the command is dangerous, false if safe.
  // args is the list of tokens AFTER the command name (e.g., after "git branch").
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  // When false, the tool does NOT respect POSIX `--` end-of-options.
  // validateFlags will continue checking flags after `--` instead of breaking.
  // Default: true (most tools respect `--`).
  respectsDoubleDash?: boolean
}

// Command maps — extracted to sub-module
export {
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
} from './readOnlyCommandValidation/commandMaps.js'

// ---------------------------------------------------------------------------
// UNC path detection (shared across Bash and PowerShell)
// ---------------------------------------------------------------------------

/**
 * Check if a path or command contains a UNC path that could trigger network
 * requests (NTLM/Kerberos credential leakage, WebDAV attacks).
 *
 * This function detects:
 * - Basic UNC paths: \\server\share, \\foo.com\file
 * - WebDAV patterns: \\server@SSL@8443\, \\server@8443@SSL\, \\server\DavWWWRoot\
 * - IP-based UNC: \\192.168.1.1\share, \\[2001:db8::1]\share
 * - Forward-slash variants: //server/share
 *
 * @param pathOrCommand The path or command string to check
 * @returns true if the path/command contains potentially vulnerable UNC paths
 */
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  // Only check on Windows platform
  if (getPlatform() !== 'windows') {
    return false
  }

  // 1. Check for general UNC paths with backslashes
  // Pattern matches: \\server, \\server\share, \\server/share, \\server@port\share
  // Uses [^\s\\/]+ for hostname to catch Unicode homoglyphs and other non-ASCII chars
  // Trailing accepts both \ and / since Windows treats both as path separators
  const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (backslashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 2. Check for forward-slash UNC paths
  // Pattern matches: //server, //server/share, //server\share, //192.168.1.1/share
  // Uses negative lookbehind (?<!:) to exclude URLs (https://, http://, ftp://)
  // while catching // preceded by quotes, =, or any other non-colon character.
  // Trailing accepts both / and \ since Windows treats both as path separators
  const forwardSlashUncPattern =
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() on short command strings
    /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (forwardSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 3. Check for mixed-separator UNC paths (forward slash + backslashes)
  // On Windows/Cygwin, /\ is equivalent to // since both are path separators.
  // In bash, /\\server becomes /\server after escape processing, which is a UNC path.
  // Requires 2+ backslashes after / because a single backslash just escapes the next char
  // (e.g., /\a → /a after bash processing, which is NOT a UNC path).
  const mixedSlashUncPattern = /\/\\{2,}[^\s\\/]/
  if (mixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 4. Check for mixed-separator UNC paths (backslashes + forward slash)
  // \\/server in bash becomes \/server after escape processing, which is a UNC path
  // on Windows since both \ and / are path separators.
  const reverseMixedSlashUncPattern = /\\{2,}\/[^\s\\/]/
  if (reverseMixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 5. Check for WebDAV SSL/port patterns
  // Examples: \\server@SSL@8443\path, \\server@8443@SSL\path
  if (/@SSL@\d+/i.test(pathOrCommand) || /@\d+@SSL/i.test(pathOrCommand)) {
    return true
  }

  // 6. Check for DavWWWRoot marker (Windows WebDAV redirector)
  // Example: \\server\DavWWWRoot\path
  if (/DavWWWRoot/i.test(pathOrCommand)) {
    return true
  }

  // 7. Check for UNC paths with IPv4 addresses (explicit check for defense-in-depth)
  // Examples: \\192.168.1.1\share, \\10.0.0.1\path
  if (
    /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand) ||
    /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  // 8. Check for UNC paths with bracketed IPv6 addresses (explicit check for defense-in-depth)
  // Examples: \\[2001:db8::1]\share, \\[::1]\path
  if (
    /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand) ||
    /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Flag validation utilities
// ---------------------------------------------------------------------------

// Regex pattern to match valid flag names (letters, digits, underscores, hyphens)
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/

/**
 * Validates flag arguments based on their expected type
 */
export function validateFlagArgument(
  value: string,
  argType: FlagArgType,
): boolean {
  switch (argType) {
    case 'none':
      return false // Should not have been called for 'none' type
    case 'number':
      return /^\d+$/.test(value)
    case 'string':
      return true // Any string including empty is valid
    case 'char':
      return value.length === 1
    case '{}':
      return value === '{}'
    case 'EOF':
      return value === 'EOF'
    default:
      return false
  }
}

/**
 * Validates the flags/arguments portion of a tokenized command against a config.
 * This is the flag-walking loop extracted from BashTool's isCommandSafeViaFlagParsing.
 *
 * @param tokens - Pre-tokenized args (from bash shell-quote or PowerShell AST)
 * @param startIndex - Where to start validating (after command tokens)
 * @param config - The safe flags config
 * @param options.commandName - For command-specific handling (git numeric shorthand, grep/rg attached numeric)
 * @param options.rawCommand - For additionalCommandIsDangerousCallback
 * @param options.xargsTargetCommands - If provided, enables xargs-style target command detection
 * @returns true if all flags are valid, false otherwise
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: {
    commandName?: string
    rawCommand?: string
    xargsTargetCommands?: string[]
  },
): boolean {
  let i = startIndex

  while (i < tokens.length) {
    let token = tokens[i]
    if (!token) {
      i++
      continue
    }

    // Special handling for xargs: once we find the target command, stop validating flags
    if (
      options?.xargsTargetCommands &&
      options.commandName === 'xargs' &&
      (!token.startsWith('-') || token === '--')
    ) {
      if (token === '--' && i + 1 < tokens.length) {
        i++
        token = tokens[i]
      }
      if (token && options.xargsTargetCommands.includes(token)) {
        break
      }
      return false
    }

    if (token === '--') {
      // SECURITY: Only break if the tool respects POSIX `--` (default: true).
      // Tools like pyright don't respect `--` — they treat it as a file path
      // and continue processing subsequent tokens as flags. Breaking here
      // would let `pyright -- --createstub os` auto-approve a file-write flag.
      if (config.respectsDoubleDash !== false) {
        i++
        break // Everything after -- is arguments
      }
      // Tool doesn't respect --: treat as positional arg, keep validating
      i++
      continue
    }

    if (token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)) {
      // Handle --flag=value format
      // SECURITY: Track whether the token CONTAINS `=` separately from
      // whether the value is non-empty. `-E=` has `hasEquals=true` but
      // `inlineValue=''` (falsy). Without `hasEquals`, the falsy check at
      // line ~1813 would fall through to "consume next token" — but GNU
      // getopt for short options with mandatory arg sees `-E=` as `-E` with
      // ATTACHED arg `=` (it doesn't strip `=` for short options). Parser
      // differential: validator advances 2 tokens, GNU advances 1.
      //
      // Attack: `xargs -E= EOF echo foo` (zero permissions)
      //   Validator: inlineValue='' falsy → consumes EOF as -E arg → i+=2 →
      //     echo ∈ SAFE_TARGET_COMMANDS_FOR_XARGS → break → AUTO-ALLOWED
      //   GNU xargs: -E attached arg=`=` → EOF is TARGET COMMAND → CODE EXEC
      //
      // Fix: when hasEquals is true, use inlineValue (even if empty) as the
      // provided arg. validateFlagArgument('', 'EOF') → false → rejected.
      // This is correct for all arg types: the user explicitly typed `=`,
      // indicating they provided a value (empty). Don't consume next token.
      const hasEquals = token.includes('=')
      const [flag, ...valueParts] = token.split('=')
      const inlineValue = valueParts.join('=')

      if (!flag) {
        return false
      }

      const flagArgType = config.safeFlags[flag]

      if (!flagArgType) {
        // Special case: git commands support -<number> as shorthand for -n <number>
        if (options?.commandName === 'git' && flag.match(/^-\d+$/)) {
          // This is equivalent to -n flag which is safe for git log/diff/show
          i++
          continue
        }

        // Handle flags with directly attached numeric arguments (e.g., -A20, -B10)
        // Only apply this special handling to grep and rg commands
        if (
          (options?.commandName === 'grep' || options?.commandName === 'rg') &&
          flag.startsWith('-') &&
          !flag.startsWith('--') &&
          flag.length > 2
        ) {
          const potentialFlag = flag.substring(0, 2) // e.g., '-A' from '-A20'
          const potentialValue = flag.substring(2) // e.g., '20' from '-A20'

          if (config.safeFlags[potentialFlag] && /^\d+$/.test(potentialValue)) {
            // This is a flag with attached numeric argument
            const flagArgType = config.safeFlags[potentialFlag]
            if (flagArgType === 'number' || flagArgType === 'string') {
              // Validate the numeric value
              if (validateFlagArgument(potentialValue, flagArgType)) {
                i++
                continue
              } else {
                return false // Invalid attached value
              }
            }
          }
        }

        // Handle combined single-letter flags like -nr
        // SECURITY: We must NOT allow any bundled flag that takes an argument.
        // GNU getopt bundling semantics: when an arg-taking option appears LAST
        // in a bundle with no trailing chars, the NEXT argv element is consumed
        // as its argument. So `xargs -rI echo sh -c id` is parsed by xargs as:
        //   -r (no-arg) + -I with replace-str=`echo`, target=`sh -c id`
        // Our naive handler previously only checked EXISTENCE in safeFlags (both
        // `-r: 'none'` and `-I: '{}'` are truthy), then `i++` consumed ONE token.
        // This created a parser differential: our validator thought `echo` was
        // the xargs target (in SAFE_TARGET_COMMANDS_FOR_XARGS → break), but
        // xargs ran `sh -c id`. ARBITRARY RCE with only Bash(echo:*) or less.
        //
        // Fix: require ALL bundled flags to have arg type 'none'. If any bundled
        // flag requires an argument (non-'none' type), reject the whole bundle.
        // This is conservative — it blocks `-rI` (xargs) entirely, but that's
        // the safe direction. Users who need `-I` can use it unbundled: `-r -I {}`.
        if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
          for (let j = 1; j < flag.length; j++) {
            const singleFlag = '-' + flag[j]
            const flagType = config.safeFlags[singleFlag]
            if (!flagType) {
              return false // One of the combined flags is not safe
            }
            // SECURITY: Bundled flags must be no-arg type. An arg-taking flag
            // in a bundle consumes the NEXT token in GNU getopt, which our
            // handler doesn't model. Reject to avoid parser differential.
            if (flagType !== 'none') {
              return false // Arg-taking flag in a bundle — cannot safely validate
            }
          }
          i++
          continue
        } else {
          return false // Unknown flag
        }
      }

      // Validate flag arguments
      if (flagArgType === 'none') {
        // SECURITY: hasEquals covers `-FLAG=` (empty inline). Without it,
        // `-FLAG=` with 'none' type would pass (inlineValue='' is falsy).
        if (hasEquals) {
          return false // Flag should not have a value
        }
        i++
      } else {
        let argValue: string
        // SECURITY: Use hasEquals (not inlineValue truthiness). `-E=` must
        // NOT consume next token — the user explicitly provided empty value.
        if (hasEquals) {
          argValue = inlineValue
          i++
        } else {
          // Check if next token is the argument
          if (
            i + 1 >= tokens.length ||
            (tokens[i + 1] &&
              tokens[i + 1]!.startsWith('-') &&
              tokens[i + 1]!.length > 1 &&
              FLAG_PATTERN.test(tokens[i + 1]!))
          ) {
            return false // Missing required argument
          }
          argValue = tokens[i + 1] || ''
          i += 2
        }

        // Defense-in-depth: For string arguments, reject values that start with '-'
        // This prevents type confusion attacks where a flag marked as 'string'
        // but actually takes no arguments could be used to inject dangerous flags
        // Exception: git's --sort flag can have values starting with '-' for reverse sorting
        if (flagArgType === 'string' && argValue.startsWith('-')) {
          // Special case: git's --sort flag allows - prefix for reverse sorting
          if (
            flag === '--sort' &&
            options?.commandName === 'git' &&
            argValue.match(/^-[a-zA-Z]/)
          ) {
            // This looks like a reverse sort (e.g., -refname, -version:refname)
            // Allow it if the rest looks like a valid sort key
          } else {
            return false
          }
        }

        // Validate argument based on type
        if (!validateFlagArgument(argValue, flagArgType)) {
          return false
        }
      }
    } else {
      // Non-flag argument (like revision specs, file paths, etc.) - this is allowed
      i++
    }
  }

  return true
}
