export type ServiceStatus =
  | 'healthy'
  | 'running'
  | 'starting'
  | 'restarting'
  | 'unhealthy'
  | 'exited'
  /** Exited by a stop signal (SIGTERM, SIGINT, or SIGKILL after the stop timeout), not by the OOM killer. */
  | 'stopped'
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
  /** Short ids of the service's containers, as `docker compose ps` prints them. */
  containerIds: string[]
  /** The image the container runs, or the one the file names while nothing runs. */
  image: string
  /** Whether the file builds the image (`build:`), so a rebuild means something. */
  hasBuild: boolean
}

export type Snapshot = {
  project: string
  file: string
  services: Service[]
  checkedAt: number
}

/** CPU in percent of one core, memory in bytes. */
export type Usage = { cpuPercent: number; memBytes: number }

/** One `docker stats` sample: the project's total and each service's share. */
export type Stats = {
  total: Usage
  byService: Record<string, Usage>
}

/** `no-compose`: no compose file in the session directory; the band hides. */
export type Availability = 'ok' | 'no-compose' | 'no-daemon'

export type Panel = {
  availability: Availability
  snapshot: Snapshot | null
  /** Sampled on its own, slower cadence; null until the first sample or while nothing runs. */
  stats: Stats | null
  /** What an action in flight is doing, e.g. "restarting api". */
  busy: string | null
  /** The last action's failure, shown until the next action. */
  error: string | null
  /** Why docker is unreachable while `availability` is `no-daemon`; cleared once it answers again. */
  daemonError: string | null
  /** Hidden with `/docker-panel hide`; kept across sessions in the plugin's store. */
  isHidden: boolean
}

/** The control pane's own state: which service cards show their logs, and those logs. */
export type PaneView = {
  expanded: string[]
  logs: Record<string, string[]>
}

declare module 'claude-code' {
  interface PluginState {
    'docker-panel': { panel: Panel; pane: PaneView }
  }
}
