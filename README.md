# Claude Code — Stability Patches

> Me and Claude are on a mission to make Claude Code rock stable. This is round one.

---

## The Story

We used Claude Code to audit itself. It found the bugs. We planned the fixes together. Then spun up 3 parallel Claude agents — they shipped all 5 phases in under 3 minutes.

AI debugging AI, together. This is just the beginning.

This repo contains the full TypeScript source of [Claude Code](https://claude.ai/claude-code) (Anthropic's CLI) with every fix applied — surgical, production-grade, independently shippable. And we're not stopping here.

---

## What We Found Wrong (Round 1)

Long-running Claude Code sessions (especially with agent swarms) had compounding stability issues nobody was seeing:

| Category | What Was Broken | What It Caused |
|----------|----------------|----------------|
| **Memory Leaks** | `agentNameRegistry`, `todos`, `sentSkillNames`, and `agentTranscriptSubdirs` Maps grew forever — nothing ever cleaned them up | RSS ballooning, eventual OOM in long sessions |
| **Silent Errors** | 9 `.catch(() => {})` calls across bridge, API, and session code just... ate errors | Network failures, auth issues, stream leaks — all invisible. Good luck debugging production |
| **Concurrency Races** | History flush used a hand-rolled `isWriting` boolean flag — classic race condition | Entries skipped under rapid concurrent calls |
| **Resource Leaks** | `chokidar` file watchers closed with `void watcher.close()` (fire-and-forget) | File descriptor exhaustion in long sessions |
| **No Cache Lifecycle** | 10+ independent module-level caches, no unified clear | Stale data after `/clear`, unbounded growth |

---

## How We Fixed It

### Phase 1: Memory Leak Containment (5 fixes)

We built a **centralized eviction hook system** — a pub-sub so all cleanup logic runs automatically when tasks die. No more manually wiring cleanup into every eviction path.

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

We built a `logAndSwallow` utility — drop-in replacement for `.catch(() => {})` that actually tells you what happened:

```typescript
// Before (good luck debugging this in production)
await api.deregisterEnvironment(envId).catch(() => {})

// After (now you can actually see what failed)
await api.deregisterEnvironment(envId).catch(logAndSwallow('bridge:env-deregister'))
```

Replaced all 9 silent catches across bridge teardown, stream cancellation, and session management.

**Files changed:**
- `utils/errors.ts` — new `logAndSwallow()` utility
- `bridge/replBridge.ts` — 6 silent catches replaced
- `bridge/initReplBridge.ts` — 1 silent catch replaced
- `bridge/replBridgeHandle.ts` — 1 silent catch replaced
- `services/api/claude.ts` — 1 silent catch replaced (stream cancel)

### Phase 3: Concurrency Safety (2 fixes)

Replaced the hand-rolled flag-based state machine with **promise-chain serialization**. Simple, correct, no more races:

```typescript
// Before (race-prone — can skip entries)
let isWriting = false
async function flushPromptHistory(retries) {
  if (isWriting) return  // ← entries dropped here
  isWriting = true
  // ...
}

// After (naturally serialized, zero races)
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

Every `chokidar` watcher `.close()` call now properly awaited. No more leaking file descriptors on fast exit:

```typescript
// Before (FD leak if process exits before chokidar finishes)
void watcher.close()

// After
await watcher.close()
```

**Files changed:**
- `keybindings/loadUserBindings.ts` — async dispose with awaited close
- `utils/hooks/fileChangedWatcher.ts` — async dispose with awaited close

### Phase 5: Structural Hardening (1 fix)

Built a **centralized cache registry** so all module-level caches have a unified lifecycle:

```typescript
registerCache('hlCache', () => hlCache.clear())
registerCache('tokenCache', () => tokenCache.clear())
// ...
clearAllCaches()  // called on /clear and session reset
```

**Files changed:**
- `utils/cacheRegistry.ts` — **new** — registry with `registerCache()` / `clearAllCaches()`
- `commands/clear/caches.ts` — wired into clear command

---

## Things That Looked Broken But Weren't

Not everything that looks leaky is leaky. We investigated all of these and cleared them:

- `imageStore.ts` — already bounded (`MAX_STORED_IMAGE_PATHS = 200`)
- `intl.ts` rtfCache — bounded by finite key space (max 6 entries)
- `jetbrains.ts` pluginInstalledCache — bounded by `IdeType` enum
- `detectRepository.ts` cache — bounded by number of cwds (1–3)
- `sessionTracing.ts` interval — intentionally `.unref()`'d, serves as span GC
- `changeDetector.ts` MDM poll — cleaned up via `dispose()` + `registerCleanup`
- `pending401Handlers` — cleaned up via `.finally()`

---

## What's Next

This was round one. We're going deeper.

### Round 2: Modular Architecture (Planned)
The codebase has **676 files over 200 lines** — including 25 monsters over 2,000 lines (`print.ts` at 5,594, `messages.ts` at 5,512, `sessionStorage.ts` at 5,105). We're planning a systematic decomposition to bring every file under 200 lines. Cleaner modules, faster reviews, fewer merge conflicts.

### Round 3: Critical TODO Debt
Production TODOs that need resolution:
- **Cross-process lockfile for MCP auth token refresh** — prevents wasted concurrent refresh requests (`services/mcp/auth.ts`)
- **EPIPE handling test coverage** — hook subprocess pipe errors need tests (`utils/hooks.ts`)
- **Keep-alive permanent solution** — replace the SystemAPIErrorMessage stopgap (`services/api/withRetry.ts`)

### Round 4: Test Infrastructure
No test framework exists in this codebase today. We want to add:
- Per-fix unit tests — spawn/evict agents, assert Map sizes return to baseline
- Long-session soak tests — 50+ agent spawns, monitor heap over time
- Concurrency stress tests — rapid concurrent history writes
- Resource leak verification — `lsof` FD counts after dispose

The goal: make Claude Code the most reliable AI CLI out there. We're not done yet.

---

## How We Built This

1. **We used Claude Code to audit its own source** — deep static analysis across 500K+ lines of TypeScript
2. **Planned the fixes together** — each scoped to be surgical, independently shippable, minimal blast radius
3. **Spun up 3 parallel Claude agents** — memory leak fixer, error visibility fixer, concurrency/resource fixer
4. **All 5 phases shipped in ~3 minutes** wall clock

AI debugging AI, with a human in the loop deciding what matters. And we're just getting started.

---

## License

This repository contains modified source from Claude Code (Anthropic). See Anthropic's terms for usage.
