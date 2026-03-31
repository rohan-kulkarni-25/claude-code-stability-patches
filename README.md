# Claude Code — Stability Patches

> Surgical fixes for memory leaks, silent error swallowing, concurrency races, and resource leaks in the Claude Code CLI core.

---

## What This Is

This repository contains the TypeScript source of [Claude Code](https://claude.ai/claude-code) (Anthropic's CLI) with **targeted stability improvements** identified through deep static analysis of the codebase. These are production-grade fixes — each independently shippable and testable — prioritized by user-facing impact.

## The Problem

Long-running Claude Code sessions (especially with agent swarms) suffered from compounding instability:

| Category | Issue | Impact |
|----------|-------|--------|
| **Memory Leaks** | `agentNameRegistry`, `todos`, `sentSkillNames`, and `agentTranscriptSubdirs` Maps grew unbounded as agents spawned — nothing ever cleaned them up | RSS growth over time, eventual OOM in long sessions |
| **Silent Errors** | 9 `.catch(() => {})` calls across bridge, API, and session code swallowed errors silently | Production debugging impossible — network failures, auth issues, and stream leaks invisible |
| **Concurrency Races** | History flush used a manual `isWriting` boolean flag that could skip entries under rapid concurrent calls | Potential history entry loss |
| **Resource Leaks** | `chokidar` file watchers closed with `void watcher.close()` (fire-and-forget) | File descriptor exhaustion in long sessions |
| **No Cache Lifecycle** | 10+ independent module-level caches with no unified clear mechanism | Stale data after conversation clear, unbounded growth |

## The Fix

### Phase 1: Memory Leak Containment (5 fixes)

**Centralized eviction hooks** (`utils/task/evictionHooks.ts`) — a pub-sub system so all cleanup logic runs automatically when tasks are evicted, preventing future leaks by design.

```
Task evicted → notifyTaskEvicted(taskId)
  ├── Delete from agentNameRegistry (was: never cleaned)
  ├── Delete from todos (was: never cleaned)
  ├── clearAgentTranscriptSubdir (was: missed on some exit paths)
  └── clearSentSkillNamesForAgent (was: never cleaned)
```

**Files changed:**
- `utils/task/evictionHooks.ts` — **new** — centralized lifecycle hook
- `utils/task/framework.ts` — cleanup in `evictTerminalTask()` and `applyTaskOffsetsAndEvictions()`
- `utils/swarm/inProcessRunner.ts` — transcript subdir cleanup on both success and failure paths
- `utils/attachments.ts` — per-agent skill name cleanup export

### Phase 2: Silent Error Visibility (9 catches fixed)

**`logAndSwallow` utility** — a drop-in replacement for `.catch(() => {})` that logs to debug output:

```typescript
// Before (invisible failures)
await api.deregisterEnvironment(envId).catch(() => {})

// After (debuggable)
await api.deregisterEnvironment(envId).catch(logAndSwallow('bridge:env-deregister'))
```

**Files changed:**
- `utils/errors.ts` — new `logAndSwallow()` utility
- `bridge/replBridge.ts` — 6 silent catches replaced
- `bridge/initReplBridge.ts` — 1 silent catch replaced
- `bridge/replBridgeHandle.ts` — 1 silent catch replaced
- `services/api/claude.ts` — 1 silent catch replaced (stream cancel)

### Phase 3: Concurrency Safety (2 fixes)

**Promise-chain serialization** for history flushes:

```typescript
// Before (race-prone flag-based state machine)
let isWriting = false
async function flushPromptHistory(retries) {
  if (isWriting) return  // ← can skip entries
  isWriting = true
  // ...
}

// After (naturally serialized)
let flushQueue = Promise.resolve()
async function flushPromptHistory() {
  flushQueue = flushQueue.then(() => immediateFlushHistory())
  return flushQueue
}
```

**Files changed:**
- `history.ts` — replaced flag-based flush with promise chain
- `state/AppStateStore.ts` — documented single-writer assumption on speculation mutable refs

### Phase 4: Resource Leak Prevention (2 fixes)

All `chokidar` watcher `.close()` calls now properly awaited:

```typescript
// Before (FD leak on fast exit)
void watcher.close()

// After
await watcher.close()
```

**Files changed:**
- `keybindings/loadUserBindings.ts` — async dispose with awaited close
- `utils/hooks/fileChangedWatcher.ts` — async dispose with awaited close

### Phase 5: Structural Hardening (1 fix)

**Centralized cache registry** for unified lifecycle management:

```typescript
registerCache('hlCache', () => hlCache.clear())
registerCache('tokenCache', () => tokenCache.clear())
// ...
clearAllCaches()  // called on /clear and session reset
```

**Files changed:**
- `utils/cacheRegistry.ts` — **new** — registry with `registerCache()` / `clearAllCaches()`
- `commands/clear/caches.ts` — wired into clear command

## Items Investigated and Confirmed Non-Issues

Not everything that looks leaky is leaky. These were analyzed and cleared:

- `imageStore.ts` — already bounded (`MAX_STORED_IMAGE_PATHS = 200`)
- `intl.ts` rtfCache — bounded by finite key space (max 6 entries)
- `jetbrains.ts` pluginInstalledCache — bounded by `IdeType` enum
- `detectRepository.ts` cache — bounded by number of cwds (1–3)
- `sessionTracing.ts` interval — intentionally `.unref()`'d, serves as span GC
- `changeDetector.ts` MDM poll — cleaned up via `dispose()` + `registerCleanup`
- `pending401Handlers` — cleaned up via `.finally()`

## How It Was Built

Every fix in this repo was **planned by Claude Code, then implemented by a team of 3 parallel Claude Code agents** — each handling an independent phase of the work:

1. **Deep analysis** — Claude explored the full codebase, identified real issues vs false positives
2. **Surgical planning** — each fix scoped to be independently shippable with minimal blast radius
3. **Parallel execution** — 3 agents worked simultaneously on memory leaks, error visibility, and concurrency/resource fixes
4. **Verification** — all changes reviewed against the original plan

Total implementation time: ~3 minutes wall clock.

## License

This repository contains modified source from Claude Code (Anthropic). See Anthropic's terms for usage.
