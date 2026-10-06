export type ServiceStatus =
  | 'healthy'
  | 'running'
  | 'starting'
  | 'restarting'
  | 'unhealthy'
  | 'exited'
  | 'created'
  | 'paused'
  | 'absent'

/** Why a running container no longer matches what `up` would create now. */
export type StaleReason = 'config' | 'image'

export type Service = {
  name: string
  status: ServiceStatus
  /** Docker's own words for the state, e.g. "Up 20 minutes (healthy)". */
  statusText: string
  exitCode: number
  restarts: number
  ports: number[]
  stale: StaleReason | null
  /** Last log lines, fetched only for services in trouble. */
  logTail: string[]
}

export type Snapshot = {
  project: string
  file: string
  services: Service[]
  checkedAt: number
}

/** `no-compose`: no compose file in the session directory; the band hides. */
export type Availability = 'ok' | 'no-compose' | 'no-daemon'

export type Panel = {
  availability: Availability
  snapshot: Snapshot | null
  /** What an action in flight is doing, e.g. "restarting api". */
  busy: string | null
  /** The last action's failure, shown until the next action or refresh. */
  error: string | null
  /** Hidden with `/docker hide`; kept across sessions in the plugin's store. */
  isHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'docker-panel': { panel: Panel }
  }
}
