// Pure parsing and derivation over docker CLI output; no `$` here, so tests reach it directly.
import type { Service, ServiceStatus, Snapshot, StaleReason, Stats, Usage } from '../types'

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

/** Container lifecycle events worth a refresh; healthcheck exec_* noise is not among them. */
const RELEVANT_ACTION = /^(create|start|restart|stop|die|kill|destroy|pause|unpause|oom|health_status)/

export type ConfigService = { name: string; buildDockerfile: string | null; image: string | null }
export type ComposeConfig = { project: string; services: ConfigService[] }

export type PsRow = {
  id: string
  service: string
  state: string
  health: string
  exitCode: number
  statusText: string
  ports: number[]
  configHash: string | null
  image: string
}

export type ContainerFacts = { restarts: number; imageId: string }

export type Inputs = {
  config: ComposeConfig
  file: string
  rows: PsRow[]
  hashes: Record<string, string>
  facts: Record<string, ContainerFacts>
  imageCreatedMs: Record<string, number>
  dockerfileMtimeMs: Record<string, number>
  logTails: Record<string, string[]>
  checkedAt: number
}

export function parseConfig(json: string): ComposeConfig {
  const data = JSON.parse(json) as {
    name?: string
    services?: Record<string, { image?: string; build?: { context?: string; dockerfile?: string } }>
  }
  const services = Object.entries(data.services ?? {}).map(([name, spec]) => ({
    name,
    buildDockerfile: spec.build?.context
      ? joinPath(spec.build.context, spec.build.dockerfile ?? 'Dockerfile')
      : null,
    image: spec.image ?? null,
  }))
  return { project: data.name ?? 'compose', services }
}

/** `docker compose config --hash '*'`: one "<service> <hash>" per line. */
export function parseHashes(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const [service, hash] = line.trim().split(/\s+/)
    if (service && hash) out[service] = hash
  }
  return out
}

/** `docker compose ps -a --format json`: NDJSON, or a JSON array on older releases. */
export function parsePs(text: string): PsRow[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const raw: unknown[] = trimmed.startsWith('[')
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)
  return raw.map(item => toPsRow(item as Record<string, unknown>))
}

function toPsRow(item: Record<string, unknown>): PsRow {
  const publishers = (item.Publishers as { PublishedPort?: number }[] | null) ?? []
  const ports = [...new Set(publishers.map(p => p.PublishedPort ?? 0).filter(p => p > 0))].sort(
    (a, b) => a - b,
  )
  const labels = String(item.Labels ?? '')
  const hash = /com\.docker\.compose\.config-hash=([0-9a-f]{64})/.exec(labels)
  return {
    id: String(item.ID ?? ''),
    service: String(item.Service ?? ''),
    state: String(item.State ?? ''),
    health: String(item.Health ?? ''),
    exitCode: Number(item.ExitCode ?? 0),
    statusText: String(item.Status ?? ''),
    ports,
    configHash: hash?.[1] ?? null,
    image: String(item.Image ?? ''),
  }
}

/** `docker inspect --format '{{.Id}}|{{.RestartCount}}|{{.Image}}'`, keyed by the short id ps prints. */
export function parseInspect(text: string): Record<string, ContainerFacts> {
  const out: Record<string, ContainerFacts> = {}
  for (const line of text.split('\n')) {
    const [id, restarts, imageId] = line.trim().split('|')
    if (id && imageId) out[id.slice(0, 12)] = { restarts: Number(restarts) || 0, imageId }
  }
  return out
}

/** `docker image inspect --format '{{.Id}}|{{.Created}}'`. */
export function parseImageCreated(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const [id, created] = line.trim().split('|')
    const ms = Date.parse(created ?? '')
    if (id && !Number.isNaN(ms)) out[id] = ms
  }
  return out
}

export function isRelevantEvent(line: string): boolean {
  try {
    const event = JSON.parse(line) as { type?: string; action?: string }
    return event.type === 'container' && RELEVANT_ACTION.test(event.action ?? '')
  } catch {
    return false
  }
}

export function statusOf(row: PsRow | undefined): ServiceStatus {
  if (!row) return 'absent'
  if (row.state === 'running') {
    if (row.health === 'healthy') return 'healthy'
    if (row.health === 'unhealthy') return 'unhealthy'
    if (row.health === 'starting') return 'starting'
    return 'running'
  }
  if (row.state === 'restarting') return 'restarting'
  if (row.state === 'paused') return 'paused'
  if (row.state === 'created') return 'created'
  return 'exited'
}

function staleOf(inputs: Inputs, service: ConfigService, row: PsRow | undefined): StaleReason | null {
  if (!row || row.state !== 'running') return null
  const want = inputs.hashes[service.name]
  if (want && row.configHash && want !== row.configHash) return 'config'
  const imageId = inputs.facts[row.id]?.imageId
  const built = imageId ? inputs.imageCreatedMs[imageId] : undefined
  const edited = service.buildDockerfile ? inputs.dockerfileMtimeMs[service.buildDockerfile] : undefined
  if (built !== undefined && edited !== undefined && edited > built) return 'image'
  return null
}

export function buildSnapshot(inputs: Inputs): Snapshot {
  const services: Service[] = inputs.config.services.map(service => {
    // Several replicas collapse into the worst one, which is the one worth showing.
    const rows = inputs.rows.filter(r => r.service === service.name)
    const row = rows.sort((a, b) => SEVERITY[statusOf(b)] - SEVERITY[statusOf(a)])[0]
    return {
      name: service.name,
      status: statusOf(row),
      statusText: row?.statusText ?? 'not created',
      exitCode: row?.exitCode ?? 0,
      restarts: row ? (inputs.facts[row.id]?.restarts ?? 0) : 0,
      ports: [...new Set(rows.flatMap(r => r.ports))].sort((a, b) => a - b),
      stale: staleOf(inputs, service, row),
      logTail: inputs.logTails[service.name] ?? [],
      containerIds: rows.map(r => r.id),
      image: row?.image || service.image || (service.buildDockerfile ? 'built locally' : ''),
      hasBuild: service.buildDockerfile !== null,
    }
  })
  return { project: inputs.config.project, file: inputs.file, services, checkedAt: inputs.checkedAt }
}

const SEVERITY: Record<ServiceStatus, number> = {
  healthy: 0,
  running: 0,
  paused: 1,
  created: 1,
  absent: 1,
  starting: 2,
  restarting: 4,
  unhealthy: 4,
  exited: 3,
}

/** A service in trouble: crashed, crash-looping or failing its healthcheck. */
export function isFailingState(status: ServiceStatus, exitCode: number): boolean {
  return status === 'unhealthy' || status === 'restarting' || (status === 'exited' && exitCode !== 0)
}

export function isFailing(service: Service): boolean {
  return isFailingState(service.status, service.exitCode)
}

export function isDown(snapshot: Snapshot): boolean {
  return snapshot.services.every(s => s.status === 'absent' || s.status === 'exited' || s.status === 'created')
}

export type Severity = 'ok' | 'stale' | 'failing' | 'down'

export function severityOf(snapshot: Snapshot): Severity {
  if (snapshot.services.some(isFailing)) return 'failing'
  if (isDown(snapshot)) return 'down'
  if (snapshot.services.some(s => s.stale !== null)) return 'stale'
  return 'ok'
}

/** One line per service that went wrong since the previous snapshot. */
export function newFailures(prev: Snapshot | null, next: Snapshot): string[] {
  if (!prev) return []
  const before = new Map(prev.services.map(s => [s.name, s]))
  const lines: string[] = []
  for (const service of next.services) {
    const old = before.get(service.name)
    if (!old || !isFailing(service)) continue
    const isNew = !isFailing(old) || service.restarts > old.restarts
    if (isNew) lines.push(failureText(service))
  }
  return lines
}

export function failureText(service: Service): string {
  const restarts = service.restarts > 0 ? `, ${service.restarts} restarts` : ''
  if (service.status === 'unhealthy') return `${service.name} is unhealthy${restarts}`
  if (service.status === 'restarting') return `${service.name} is crash-looping (exit ${service.exitCode}${restarts})`
  return `${service.name} exited with code ${service.exitCode}${restarts}`
}

export function staleServices(snapshot: Snapshot): string[] {
  return snapshot.services.filter(s => s.stale !== null).map(s => s.name)
}

const UNIT: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
}

/** "12.3MiB" → bytes; 0 for anything it cannot read. */
export function parseBytes(text: string): number {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim())
  if (!match) return 0
  return Number(match[1]) * (UNIT[(match[2] ?? '').toLowerCase()] ?? 0)
}

/** `docker stats --no-stream --format '{{json .}}'`, summed per service by container id. */
export function parseStats(text: string, snapshot: Snapshot): Stats {
  const serviceOf = new Map<string, string>()
  for (const service of snapshot.services) {
    for (const id of service.containerIds) serviceOf.set(id.slice(0, 12), service.name)
  }
  const byService: Record<string, Usage> = {}
  const total: Usage = { cpuPercent: 0, memBytes: 0 }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as { ID?: string; CPUPerc?: string; MemUsage?: string }
    const service = serviceOf.get(String(row.ID ?? '').slice(0, 12))
    if (!service) continue
    const cpuPercent = Number.parseFloat(row.CPUPerc ?? '') || 0
    const memBytes = parseBytes(String(row.MemUsage ?? '').split('/')[0] ?? '')
    const before = byService[service] ?? { cpuPercent: 0, memBytes: 0 }
    byService[service] = { cpuPercent: before.cpuPercent + cpuPercent, memBytes: before.memBytes + memBytes }
    total.cpuPercent += cpuPercent
    total.memBytes += memBytes
  }
  return { total, byService }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)}G`
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)}M`
  return `${Math.round(bytes / 2 ** 10)}K`
}

export function formatUsage(usage: Usage): string {
  return `CPU ${usage.cpuPercent.toFixed(usage.cpuPercent < 10 ? 1 : 0)}% · RAM ${formatBytes(usage.memBytes)}`
}

/** "5/7 up": containers running (any health) out of the services the file declares. */
export function upSummary(snapshot: Snapshot): string {
  const up = snapshot.services.filter(s => ['healthy', 'running', 'starting', 'unhealthy'].includes(s.status))
  return `${up.length}/${snapshot.services.length} up`
}

function joinPath(dir: string, file: string): string {
  return file.startsWith('/') ? file : `${dir.replace(/\/$/, '')}/${file}`
}
