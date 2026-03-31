/**
 * Centralized registry for module-level caches.
 * Caches register themselves at module load time; clearAllCaches()
 * is called during conversation clear and session reset.
 */

type ClearFn = () => void

const registeredCaches: Array<{ name: string; clear: ClearFn }> = []

/**
 * Register a module-level cache for centralized lifecycle management.
 * Call this at module scope so the cache is registered on first import.
 */
export function registerCache(name: string, clear: ClearFn): void {
  registeredCaches.push({ name, clear })
}

/**
 * Clear all registered caches. Called during conversation clear
 * and session reset to prevent stale data and unbounded growth.
 */
export function clearAllCaches(): void {
  for (const cache of registeredCaches) {
    cache.clear()
  }
}
