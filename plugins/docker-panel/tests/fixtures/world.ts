/** What the fake docker CLI answers from; a test swaps `current` to change the world mid-test. */
export type World = {
  ps: string[]
  hashes: Record<string, string>
  restarts: number
  isDaemonDown?: boolean
  /** While set, compose actions (stop, restart, up…) wait on it, so a test can look mid-action. */
  actionGate?: Promise<void>
}
