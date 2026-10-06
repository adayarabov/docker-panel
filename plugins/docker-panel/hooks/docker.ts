// Everything that queries the docker CLI. It reaches the host only through
// `Host`, which register.tsx builds over `$` (the engine never lets `$` cross
// an import), and which a test can fake.
import type { ProcessRunResult } from 'claude-code'

import type { Snapshot } from '../types'
import {
  COMPOSE_FILES,
  INSPECT_FORMAT,
  buildSnapshot,
  isFailingState,
  parseConfig,
  parseHashes,
  parseImageCreated,
  parseInspect,
  parsePs,
  statusOf,
} from './compose'

const LOG_TAIL_LINES = 8

export type Host = {
  cwd: string
  /** Runs `docker <args>` in `cwd`. */
  docker: (args: string[]) => Promise<ProcessRunResult>
  exists: (path: string) => Promise<boolean>
  /** Modification time in ms, or undefined when the file is missing. */
  mtime: (path: string) => Promise<number | undefined>
  now: () => Promise<number>
}

export type Collected =
  | { kind: 'ok'; snapshot: Snapshot }
  | { kind: 'no-compose' }
  | { kind: 'no-daemon'; reason: string }

export async function findComposeFile(host: Host): Promise<string | null> {
  for (const name of COMPOSE_FILES) {
    if (await host.exists(`${host.cwd}/${name}`)) return name
  }
  return null
}

export async function collect(host: Host): Promise<Collected> {
  const file = await findComposeFile(host)
  if (!file) return { kind: 'no-compose' }

  const info = await host.docker(['info', '--format', '{{.ServerVersion}}'])
  if (info.exitCode !== 0) return { kind: 'no-daemon', reason: lastLine(info.stderr) }

  const [configOut, hashOut, psOut] = await Promise.all([
    host.docker(['compose', 'config', '--format', 'json']),
    host.docker(['compose', 'config', '--hash', '*']),
    host.docker(['compose', 'ps', '-a', '--format', 'json']),
  ])
  if (configOut.exitCode !== 0) return { kind: 'no-daemon', reason: lastLine(configOut.stderr) }

  const config = parseConfig(configOut.stdout)
  const rows = parsePs(psOut.stdout)
  const facts = rows.length
    ? parseInspect(
        (await host.docker(['inspect', '--format', INSPECT_FORMAT, ...rows.map(r => r.id)]))
          .stdout,
      )
    : {}

  const imageIds = [...new Set(Object.values(facts).map(f => f.imageId))]
  const imageCreatedMs = imageIds.length
    ? parseImageCreated((await host.docker(['image', 'inspect', '--format', '{{.Id}}|{{.Created}}', ...imageIds])).stdout)
    : {}

  const dockerfileMtimeMs: Record<string, number> = {}
  for (const service of config.services) {
    if (!service.buildDockerfile) continue
    const mtime = await host.mtime(service.buildDockerfile)
    if (mtime !== undefined) dockerfileMtimeMs[service.buildDockerfile] = mtime
  }

  const failing = [
    ...new Set(
      rows.filter(r => isFailingState(statusOf(r, facts[r.id]?.isOomKilled), r.exitCode)).map(r => r.service),
    ),
  ]
  const logTails: Record<string, string[]> = {}
  await Promise.all(
    failing.map(async name => {
      logTails[name] = await logTail(host, name, LOG_TAIL_LINES)
    }),
  )

  const snapshot = buildSnapshot({
    config,
    file,
    rows,
    hashes: parseHashes(hashOut.stdout),
    facts,
    imageCreatedMs,
    dockerfileMtimeMs,
    logTails,
    checkedAt: await host.now(),
  })
  return { kind: 'ok', snapshot }
}

/** The last log lines of one service, or of the whole project when `service` is null. */
export async function logTail(host: Host, service: string | null, lines: number): Promise<string[]> {
  const scope = service ? ['--no-log-prefix', service] : []
  const out = await host.docker(['compose', 'logs', '--no-color', '--tail', String(lines), ...scope])
  // Containers often log to stderr; compose relays both streams.
  const text = `${out.stdout}${out.stderr}`
  return text
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
}

/**
 * The directory `/docker-panel use <arg>` points at: `arg` taken relative to the
 * session's directory unless absolute; empty or "." is the session's own.
 */
export function resolveProjectDir(sessionCwd: string, arg: string): string {
  const trimmed = arg.trim()
  const joined = trimmed.startsWith('/') ? trimmed : `${sessionCwd}/${trimmed}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Store key under which the chosen project directory is kept, per session directory. */
export function projectDirKey(sessionCwd: string): string {
  return `projectDir:${sessionCwd}`
}

export function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.trim() || 'docker did not answer'
}
