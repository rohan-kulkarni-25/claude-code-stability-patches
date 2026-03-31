import type { SimpleCommand } from '../ast.js'
import { SHELL_KEYWORDS } from '../bashParser.js'

const ZSH_DANGEROUS_BUILTINS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

/**
 * Shell builtins that evaluate their arguments as code or otherwise escape
 * the argv abstraction. A command like `eval "rm -rf /"` has argv
 * ['eval', 'rm -rf /'] which looks inert to flag validation but executes
 * the string. Treat these the same as command substitution.
 */
const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'fc',
  // `coproc rm -rf /` spawns rm as a coprocess. tree-sitter parses it as
  // a plain command with argv[0]='coproc', so permission rules and path
  // validation would check 'coproc' not 'rm'.
  'coproc',
  // Zsh precommand modifiers: `noglob cmd args` runs cmd with globbing off.
  // They parse as ordinary commands (noglob is argv[0], the real command is
  // argv[1]) so permission matching against argv[0] would see 'noglob', not
  // the wrapped command.
  'noglob',
  'nocorrect',
  // `trap 'cmd' SIGNAL` — cmd runs as shell code on signal/exit. EXIT fires
  // at end of every BashTool invocation, so this is guaranteed execution.
  'trap',
  // `enable -f /path/lib.so name` — dlopen arbitrary .so as a builtin.
  // Native code execution.
  'enable',
  // `mapfile -C callback -c N` / `readarray -C callback` — callback runs as
  // shell code every N input lines.
  'mapfile',
  'readarray',
  // `hash -p /path cmd` — poisons bash's command-lookup cache. Subsequent
  // `cmd` in the same command resolves to /path instead of PATH lookup.
  'hash',
  // `bind -x '"key":cmd'` / `complete -C cmd` — interactive-only callbacks
  // but still code-string arguments. Low impact in non-interactive BashTool
  // shells, blocked for consistency. `compgen -C cmd` is NOT interactive-only:
  // it immediately executes the -C argument to generate completions.
  'bind',
  'complete',
  'compgen',
  // `alias name='cmd'` — aliases not expanded in non-interactive bash by
  // default, but `shopt -s expand_aliases` enables them. Also blocked as
  // defense-in-depth (alias followed by name use in same command).
  'alias',
  // `let EXPR` arithmetically evaluates EXPR — identical to $(( EXPR )).
  // Array subscripts in the expression expand $(cmd) at eval time even when
  // the argument arrived single-quoted: `let 'x=a[$(id)]'` executes id.
  // tree-sitter sees the raw_string as an opaque leaf. Same primitive
  // walkArithmetic guards, but `let` is a plain command node.
  'let',
])

/**
 * Builtins that re-parse a NAME operand internally and arithmetically
 * evaluate `arr[EXPR]` subscripts — including $(cmd) in the subscript —
 * even when the argv element arrived from a single-quoted raw_string.
 * `test -v 'a[$(id)]'` → tree-sitter sees an opaque leaf, bash runs id.
 * Maps: builtin name → set of flags whose next argument is a NAME.
 */
const SUBSCRIPT_EVAL_FLAGS: Record<string, Set<string>> = {
  test: new Set(['-v', '-R']),
  '[': new Set(['-v', '-R']),
  '[[': new Set(['-v', '-R']),
  printf: new Set(['-v']),
  read: new Set(['-a']),
  unset: new Set(['-v']),
  // bash 5.1+: `wait -p VAR [id...]` stores the waited PID into VAR. When VAR
  // is `arr[EXPR]`, bash arithmetically evaluates the subscript — running
  // $(cmd) even from a single-quoted raw_string. Verified bash 5.3.9:
  // `: & wait -p 'a[$(id)]' %1` executes id.
  wait: new Set(['-p']),
}

/**
 * `[[ ARG1 OP ARG2 ]]` where OP is an arithmetic comparison. bash manual:
 * "When used with [[, Arg1 and Arg2 are evaluated as arithmetic
 * expressions." Arithmetic evaluation recursively expands array subscripts,
 * so `[[ 'a[$(id)]' -eq 0 ]]` executes `id` even though tree-sitter sees
 * the operand as an opaque raw_string leaf. Unlike -v/-R (unary, NAME after
 * flag), these are binary — the subscript can appear on EITHER side, so
 * SUBSCRIPT_EVAL_FLAGS's "next arg" logic is insufficient.
 * `[` / `test` are not vulnerable (bash errors with "integer expression
 * expected"), but the test_command handler normalizes argv[0]='[[' for
 * both forms, so they get this check too — mild over-blocking, safe side.
 */
const TEST_ARITH_CMP_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

/**
 * Builtins where EVERY non-flag positional argument is a NAME that bash
 * re-parses and arithmetically evaluates subscripts on — no flag required.
 * `read 'a[$(id)]'` executes id: each positional is a variable name to
 * assign into, and `arr[EXPR]` is valid syntax there. `unset NAME...` is
 * the same (though tree-sitter's unset_command handler currently rejects
 * raw_string children before reaching here — this is defense-in-depth).
 * NOT printf (positional args are FORMAT/data), NOT test/[ (operands are
 * values, only -v/-R take a NAME). declare/typeset/local handled in
 * declaration_command since they never reach here as plain commands.
 */
const BARE_SUBSCRIPT_NAME_BUILTINS = new Set(['read', 'unset'])

/**
 * `read` flags whose NEXT argument is data (prompt/delimiter/count/fd),
 * not a NAME. `read -p '[foo] ' var` must not trip on the `[` in the
 * prompt string. `-a` is intentionally absent — its operand IS a NAME.
 */
const READ_DATA_FLAGS = new Set(['-p', '-d', '-n', '-N', '-t', '-u', '-i'])

// SHELL_KEYWORDS imported from bashParser.ts — shell reserved words can never
// be legitimate argv[0]; if they appear, the parser mis-parsed a compound
// command. Reject to avoid nonsense argv reaching downstream.

// Use `.*` not `[^/]*` — Linux resolves `..` in procfs, so
// `/proc/self/../self/environ` works and must be caught.
export const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

/**
 * Newline followed by `#` in an argv element, env var value, or redirect target.
 * Downstream stripSafeWrappers re-tokenizes .text line-by-line and treats `#`
 * after a newline as a comment, hiding arguments that follow.
 */
export const NEWLINE_HASH_RE = /\n[ \t]*#/

export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }

/**
 * Post-argv semantic checks. Run after parseForSecurity returns 'simple' to
 * catch commands that tokenize fine but are dangerous by name or argument
 * content. Returns the first failure or {ok: true}.
 */
export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const cmd of commands) {
    // Strip safe wrapper commands (nohup, time, timeout N, nice -n N) so
    // `nohup eval "..."` and `timeout 5 jq 'system(...)'` are checked
    // against the wrapped command, not the wrapper. Inlined here to avoid
    // circular import with bashPermissions.ts.
    let a = cmd.argv
    for (;;) {
      if (a[0] === 'time' || a[0] === 'nohup') {
        a = a.slice(1)
      } else if (a[0] === 'timeout') {
        // `timeout 5`, `timeout 5s`, `timeout 5.5`, plus optional GNU flags
        // preceding the duration. Long: --foreground, --kill-after=N,
        // --signal=SIG, --preserve-status. Short: -k DUR, -s SIG, -v (also
        // fused: -k5, -sTERM).
        // SECURITY (SAST Mar 2026): the previous loop only skipped `--long`
        // flags, so `timeout -k 5 10 eval ...` broke out with name='timeout'
        // and the wrapped eval was never checked. Now handle known short
        // flags AND fail closed on any unrecognized flag — an unknown flag
        // means we can't locate the wrapped command, so we must not silently
        // fall through to name='timeout'.
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (
            arg === '--foreground' ||
            arg === '--preserve-status' ||
            arg === '--verbose'
          ) {
            i++ // known no-value long flags
          } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // --kill-after=5, --signal=TERM (value fused with =)
          } else if (
            (arg === '--kill-after' || arg === '--signal') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // --kill-after 5, --signal TERM (space-separated)
          } else if (arg.startsWith('--')) {
            // Unknown long flag, OR --kill-after/--signal with non-allowlisted
            // value (e.g. placeholder from $() substitution). Fail closed.
            return {
              ok: false,
              reason: `timeout with ${arg} flag cannot be statically analyzed`,
            }
          } else if (arg === '-v') {
            i++ // --verbose, no argument
          } else if (
            (arg === '-k' || arg === '-s') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // -k DURATION / -s SIGNAL — separate value
          } else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // fused: -k5, -sTERM
          } else if (arg.startsWith('-')) {
            // Unknown flag OR -k/-s with non-allowlisted value — can't locate
            // wrapped cmd. Reject, don't fall through to name='timeout'.
            return {
              ok: false,
              reason: `timeout with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // non-flag — should be the duration
          }
        }
        if (a[i] && /^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) {
          a = a.slice(i + 1)
        } else if (a[i]) {
          // SECURITY (PR #21503 round 3): a[i] exists but doesn't match our
          // duration regex. GNU timeout parses via xstrtod() (libc strtod) and
          // accepts `.5`, `+5`, `5e-1`, `inf`, `infinity`, hex floats — none
          // of which match `/^\d+(\.\d+)?[smhd]?$/`. Empirically verified:
          // `timeout .5 echo ok` works. Previously this branch `break`ed
          // (fail-OPEN) so `timeout .5 eval "id"` with `Bash(timeout:*)` left
          // name='timeout' and eval was never checked. Now fail CLOSED —
          // consistent with the unknown-FLAG handling above (lines ~1895,1912).
          return {
            ok: false,
            reason: `timeout duration '${a[i]}' cannot be statically analyzed`,
          }
        } else {
          break // no more args — `timeout` alone, inert
        }
      } else if (a[0] === 'nice') {
        // `nice cmd`, `nice -n N cmd`, `nice -N cmd` (legacy). All run cmd
        // at a lower priority. argv[0] check must see the wrapped cmd.
        if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2])) {
          a = a.slice(3)
        } else if (a[1] && /^-\d+$/.test(a[1])) {
          a = a.slice(2) // `nice -10 cmd`
        } else if (a[1] && /[$(`]/.test(a[1])) {
          // SECURITY: walkArgument returns node.text for arithmetic_expansion,
          // so `nice $((0-5)) jq ...` has a[1]='$((0-5))'. Bash expands it to
          // '-5' (legacy nice syntax) and execs jq; we'd slice(1) here and
          // set name='$((0-5))' which skips the jq system() check entirely.
          // Fail closed — mirrors the timeout-duration fail-closed above.
          return {
            ok: false,
            reason: `nice argument '${a[1]}' contains expansion — cannot statically determine wrapped command`,
          }
        } else {
          a = a.slice(1) // bare `nice cmd`
        }
      } else if (a[0] === 'env') {
        // `env [VAR=val...] [-i] [-0] [-v] [-u NAME...] cmd args` runs cmd.
        // argv[0] check must see cmd, not env. Skip known-safe forms only.
        // SECURITY: -S splits a string into argv (mini-shell) — must reject.
        // -C/-P change cwd/PATH — wrapped cmd runs elsewhere, reject.
        // Any OTHER flag → reject (fail-closed, not fail-open to name='env').
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (arg.includes('=') && !arg.startsWith('-')) {
            i++ // VAR=val assignment
          } else if (arg === '-i' || arg === '-0' || arg === '-v') {
            i++ // flags with no argument
          } else if (arg === '-u' && a[i + 1]) {
            i += 2 // -u NAME unsets; takes one arg
          } else if (arg.startsWith('-')) {
            // -S (argv splitter), -C (altwd), -P (altpath), --anything,
            // or unknown flag. Can't model — reject the whole command.
            return {
              ok: false,
              reason: `env with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // the wrapped command
          }
        }
        if (i < a.length) {
          a = a.slice(i)
        } else {
          break // `env` alone (no wrapped cmd) — inert, name='env'
        }
      } else if (a[0] === 'stdbuf') {
        // `stdbuf -o0 cmd` (fused), `stdbuf -o 0 cmd` (space-separated),
        // multiple flags (`stdbuf -o0 -eL cmd`), long forms (`--output=0`).
        // SECURITY: previous handling only stripped ONE flag and fell through
        // to slice(2) for anything unrecognized, so `stdbuf --output 0 eval`
        // → ['0','eval',...] → name='0' hid eval. Now iterate all known flag
        // forms and fail closed on any unknown flag.
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (STDBUF_SHORT_SEP_RE.test(arg) && a[i + 1]) {
            i += 2 // -o MODE (space-separated)
          } else if (STDBUF_SHORT_FUSED_RE.test(arg)) {
            i++ // -o0 (fused)
          } else if (STDBUF_LONG_RE.test(arg)) {
            i++ // --output=MODE (fused long)
          } else if (arg.startsWith('-')) {
            // --output MODE (space-separated long) or unknown flag. GNU
            // stdbuf long options use `=` syntax, but getopt_long also
            // accepts space-separated — we can't enumerate safely, reject.
            return {
              ok: false,
              reason: `stdbuf with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // the wrapped command
          }
        }
        if (i > 1 && i < a.length) {
          a = a.slice(i)
        } else {
          break // `stdbuf` with no flags or no wrapped cmd — inert
        }
      } else {
        break
      }
    }
    const name = a[0]
    if (name === undefined) continue

    // SECURITY: Empty command name. Quoted empty (`"" cmd`) is harmless —
    // bash tries to exec "" and fails with "command not found". But an
    // UNQUOTED empty expansion at command position (`V="" && $V cmd`) is a
    // bypass: bash drops the empty field and runs `cmd` as argv[0], while
    // our name="" skips every builtin check below. resolveSimpleExpansion
    // rejects the $V case; this catches any other path to empty argv[0]
    // (concatenation of empties, walkString whitespace-quirk, future bugs).
    if (name === '') {
      return {
        ok: false,
        reason: 'Empty command name — argv[0] may not reflect what bash runs',
      }
    }

    // Defense-in-depth: argv[0] should never be a placeholder after the
    // var-tracking fix (static vars return real value, unknown vars reject).
    // But if a bug upstream ever lets one through, catch it here — a
    // placeholder-as-command-name means runtime-determined command → unsafe.
    if (name.includes(CMDSUB_PLACEHOLDER) || name.includes(VAR_PLACEHOLDER)) {
      return {
        ok: false,
        reason: 'Command name is runtime-determined (placeholder argv[0])',
      }
    }

    // argv[0] starts with an operator/flag: this is a fragment, not a
    // command. Likely a line-continuation leak or a mistake.
    if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
      return {
        ok: false,
        reason: 'Command appears to be an incomplete fragment',
      }
    }

    // SECURITY: builtins that re-parse a NAME operand internally. bash
    // arithmetically evaluates `arr[EXPR]` in NAME position, running $(cmd)
    // in the subscript even when the argv element arrived from a
    // single-quoted raw_string (opaque leaf to tree-sitter). Two forms:
    // separate (`printf -v NAME`) and fused (`printf -vNAME`, getopt-style).
    // `printf '[%s]' x` stays safe — `[` in format string, not after `-v`.
    const dangerFlags = SUBSCRIPT_EVAL_FLAGS[name]
    if (dangerFlags !== undefined) {
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        // Separate form: `-v` then NAME in next arg.
        if (dangerFlags.has(arg) && a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'${name} ${arg}' operand contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
        // Combined short flags: `-ra` is bash shorthand for `-r -a`.
        // Check if any danger flag character appears in a combined flag
        // string. The danger flag's NAME operand is the next argument.
        if (
          arg.length > 2 &&
          arg[0] === '-' &&
          arg[1] !== '-' &&
          !arg.includes('[')
        ) {
          for (const flag of dangerFlags) {
            if (flag.length === 2 && arg.includes(flag[1]!)) {
              if (a[i + 1]?.includes('[')) {
                return {
                  ok: false,
                  reason: `'${name} ${flag}' (combined in '${arg}') operand contains array subscript — bash evaluates $(cmd) in subscripts`,
                }
              }
            }
          }
        }
        // Fused form: `-vNAME` in one arg. Only short-option flags fuse
        // (getopt), so check -v/-a/-R. `[[` uses test_operator nodes only.
        for (const flag of dangerFlags) {
          if (
            flag.length === 2 &&
            arg.startsWith(flag) &&
            arg.length > 2 &&
            arg.includes('[')
          ) {
            return {
              ok: false,
              reason: `'${name} ${flag}' (fused) operand contains array subscript — bash evaluates $(cmd) in subscripts`,
            }
          }
        }
      }
    }

    // SECURITY: `[[ ARG OP ARG ]]` arithmetic comparison. bash evaluates
    // BOTH operands as arithmetic expressions, recursively expanding
    // `arr[$(cmd)]` subscripts even from single-quoted raw_string. Check
    // the operand adjacent to each arith-cmp operator on BOTH sides —
    // SUBSCRIPT_EVAL_FLAGS's "flag then next-arg" pattern can't express
    // "either side of a binary op". String comparisons (==/!=/=~) do NOT
    // trigger arithmetic eval — `[[ 'a[x]' == y ]]` is a literal string cmp.
    if (name === '[[') {
      // i starts at 2: a[0]='[[' (contains '['), a[1] is the first real
      // operand. A binary op can't appear before index 2.
      for (let i = 2; i < a.length; i++) {
        if (!TEST_ARITH_CMP_OPS.has(a[i]!)) continue
        if (a[i - 1]?.includes('[') || a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'[[ ... ${a[i]} ... ]]' operand contains array subscript — bash arithmetically evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // SECURITY: `read`/`unset` treat EVERY bare positional as a NAME —
    // no flag needed. `read 'a[$(id)]' <<< data` executes id even though
    // argv[1] arrived from a single-quoted raw_string and no -a flag is
    // present. Same primitive as SUBSCRIPT_EVAL_FLAGS but the trigger is
    // positional, not flag-gated. Skip operands of read's data-taking
    // flags (-p PROMPT etc.) to avoid blocking `read -p '[foo] ' var`.
    if (BARE_SUBSCRIPT_NAME_BUILTINS.has(name)) {
      let skipNext = false
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        if (skipNext) {
          skipNext = false
          continue
        }
        if (arg[0] === '-') {
          if (name === 'read') {
            if (READ_DATA_FLAGS.has(arg)) {
              skipNext = true
            } else if (arg.length > 2 && arg[1] !== '-') {
              // Combined short flag like `-rp`. Getopt-style: first
              // data-flag char consumes rest-of-arg as its operand
              // (`-p[foo]` → prompt=`[foo]`), or next-arg if last
              // (`-rp '[foo]'` → prompt=`[foo]`). So skipNext iff a
              // data-flag char appears at the END after only no-arg
              // flags like `-r`/`-s`.
              for (let j = 1; j < arg.length; j++) {
                if (READ_DATA_FLAGS.has('-' + arg[j])) {
                  if (j === arg.length - 1) skipNext = true
                  break
                }
              }
            }
          }
          continue
        }
        if (arg.includes('[')) {
          return {
            ok: false,
            reason: `'${name}' positional NAME '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // SECURITY: Shell reserved keywords as argv[0] indicate a tree-sitter
    // mis-parse. `! for i in a; do :; done` parses as `command "for i in a"`
    // + `command "do :"` + `command "done"` — tree-sitter fails to recognize
    // `for` after `!` as a compound command start. Reject: keywords can never
    // be legitimate command names, and argv like ['do','false'] is nonsense.
    if (SHELL_KEYWORDS.has(name)) {
      return {
        ok: false,
        reason: `Shell keyword '${name}' as command name — tree-sitter mis-parse`,
      }
    }

    // Check argv (not .text) to catch both single-quote (`'\n#'`) and
    // double-quote (`"\n#"`) variants. Env vars and redirects are also
    // part of the .text span so the same downstream bug applies.
    // Heredoc bodies are excluded from argv so markdown `##` headers
    // don't trigger this.
    // TODO: remove once downstream path validation operates on argv.
    for (const arg of cmd.argv) {
      if (arg.includes('\n') && NEWLINE_HASH_RE.test(arg)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a quoted argument can hide arguments from path validation',
        }
      }
    }
    for (const ev of cmd.envVars) {
      if (ev.value.includes('\n') && NEWLINE_HASH_RE.test(ev.value)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside an env var value can hide arguments from path validation',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('\n') && NEWLINE_HASH_RE.test(r.target)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a redirect target can hide arguments from path validation',
        }
      }
    }

    // jq's system() built-in executes arbitrary shell commands, and flags
    // like --from-file can read arbitrary files into jq variables. On the
    // legacy path these are caught by validateJqCommand in bashSecurity.ts,
    // but that validator is gated behind `astSubcommands === null` and
    // never runs when the AST parse succeeds. Mirror the checks here so
    // the AST path has the same defence.
    if (name === 'jq') {
      for (const arg of a) {
        if (/\bsystem\s*\(/.test(arg)) {
          return {
            ok: false,
            reason:
              'jq command contains system() function which executes arbitrary commands',
          }
        }
      }
      if (
        a.some(arg =>
          /^(?:-[fL](?:$|[^A-Za-z])|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(
            arg,
          ),
        )
      ) {
        return {
          ok: false,
          reason:
            'jq command contains dangerous flags that could execute code or read arbitrary files',
        }
      }
    }

    if (ZSH_DANGEROUS_BUILTINS.has(name)) {
      return {
        ok: false,
        reason: `Zsh builtin '${name}' can bypass security checks`,
      }
    }

    if (EVAL_LIKE_BUILTINS.has(name)) {
      // `command -v foo` / `command -V foo` are POSIX existence checks that
      // only print paths — they never execute argv[1]. Bare `command foo`
      // does bypass function/alias lookup (the concern), so keep blocking it.
      if (name === 'command' && (a[1] === '-v' || a[1] === '-V')) {
        // fall through to remaining checks
      } else if (
        name === 'fc' &&
        !a.slice(1).some(arg => /^-[^-]*[es]/.test(arg))
      ) {
        // `fc -l`, `fc -ln` list history — safe. `fc -e ed` invokes an
        // editor then executes. `fc -s [pat=rep]` RE-EXECUTES the last
        // matching command (optionally with substitution) — as dangerous
        // as eval. Block any short-opt containing `e` or `s`.
        // to avoid introducing FPs for `fc -l` (list history).
      } else if (
        name === 'compgen' &&
        !a.slice(1).some(arg => /^-[^-]*[CFW]/.test(arg))
      ) {
        // `compgen -c/-f/-v` only list completions — safe. `compgen -C cmd`
        // immediately executes cmd; `-F func` calls a shell function; `-W list`
        // word-expands its argument (including $(cmd) even from single-quoted
        // raw_string). Block any short-opt containing C/F/W (case-sensitive:
        // -c/-f are safe).
      } else {
        return {
          ok: false,
          reason: `'${name}' evaluates arguments as shell code`,
        }
      }
    }

    // /proc/*/environ exposes env vars (including secrets) of other processes.
    // Check argv and redirect targets — `cat /proc/self/environ` and
    // `cat < /proc/self/environ` both read it.
    for (const arg of cmd.argv) {
      if (arg.includes('/proc/') && PROC_ENVIRON_RE.test(arg)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('/proc/') && PROC_ENVIRON_RE.test(r.target)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
  }
  return { ok: true }
}
