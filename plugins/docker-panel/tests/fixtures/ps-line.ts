import { CONFIG_HASH } from './config-hash'

type PsLineSpec = { id: string; service: string; state: string; health?: string; exit?: number; port?: number }

/** One `docker compose ps --format json` line, as Compose v2 prints it (a port listed twice, IPv4 and IPv6). */
export function psLine(spec: PsLineSpec): string {
  return JSON.stringify({
    ID: spec.id,
    Service: spec.service,
    State: spec.state,
    Health: spec.health ?? '',
    ExitCode: spec.exit ?? 0,
    Status: spec.state === 'running' ? 'Up 2 hours' : `Exited (${spec.exit ?? 0}) 5 seconds ago`,
    Publishers: spec.port ? [{ PublishedPort: spec.port }, { PublishedPort: spec.port }] : [],
    Labels: `com.docker.compose.project=shop,com.docker.compose.config-hash=${CONFIG_HASH.old},com.docker.compose.service=${spec.service}`,
  })
}
