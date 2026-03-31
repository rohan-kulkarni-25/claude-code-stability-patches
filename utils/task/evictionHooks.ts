/**
 * Centralized task lifecycle hook for cleanup on eviction.
 * Subscribers register cleanup logic here instead of manually wiring
 * into evictTerminalTask / applyTaskOffsetsAndEvictions.
 */
type EvictionListener = (taskId: string) => void
const listeners: EvictionListener[] = []

/**
 * Register a callback to run when a task is evicted from AppState.
 * Returns an unsubscribe function.
 */
export function onTaskEvicted(listener: EvictionListener): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/**
 * Notify all registered listeners that a task has been evicted.
 * Called from evictTerminalTask and applyTaskOffsetsAndEvictions.
 */
export function notifyTaskEvicted(taskId: string): void {
  for (const listener of listeners) {
    listener(taskId)
  }
}
