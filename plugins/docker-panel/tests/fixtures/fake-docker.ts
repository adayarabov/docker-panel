import { mock } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'

import { CWD } from './cwd'
import type { World } from './world'

const CONFIG = JSON.stringify({
  name: 'shop',
  services: { web: {}, api: { build: { context: `${CWD}/api`, dockerfile: 'Dockerfile' } }, db: {} },
})

const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'

/** A finished docker command, as `$.process.run` answers. */
const exited = (exitCode: number, stdout: string, stderr = ''): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/**
 * The world beneath the mod: the docker CLI answered from `world.current` (every
 * argv recorded in `ran`), a compose file at `CWD`, and the engine's own answers
 * for the session, commands, store, toasts and the band it draws when the mod passes.
 */
export function fakeDocker(on: On, world: { current: World }, ran: string[][]): void {
  on('process.run', async (_$, e) => {
    const args = [...e.argv].slice(1)
    ran.push(args)
    const joined = args.join(' ')
    if (joined.startsWith('info')) return world.current.isDaemonDown ? exited(1, '', DAEMON_DOWN) : exited(0, '29.0.0')
    if (joined === 'compose config --format json') return exited(0, CONFIG)
    if (joined.startsWith('compose config --hash')) {
      return exited(0, Object.entries(world.current.hashes).map(([s, h]) => `${s} ${h}`).join('\n'))
    }
    if (joined.startsWith('compose ps')) return exited(0, world.current.ps.join('\n'))
    if (args[0] === 'inspect') {
      return exited(0, args.slice(3).map(id => `${id}ffff|${world.current.restarts}|sha256:img|false`).join('\n'))
    }
    if (args[0] === 'image') return exited(0, 'sha256:img|2026-10-01T00:00:00Z')
    if (args[0] === 'compose' && ['stop', 'restart', 'up', 'down'].includes(args[1] ?? '')) {
      await world.current.actionGate
      return exited(0, '')
    }
    if (joined.startsWith('compose logs')) return exited(0, 'Error: password authentication failed for user "shop"')
    if (args[0] === 'stats') {
      const rows = args.slice(4).map(id => JSON.stringify({ ID: id, CPUPerc: '1.50%', MemUsage: '100MiB / 15GiB' }))
      return exited(0, rows.join('\n'))
    }
    return exited(0, '')
  })
  on('fs.exists', async (_$, e) => ({ value: e.path === `${CWD}/compose.yaml` }))
  on('fs.stat', async () => ({
    value: { kind: 'file' as const, size: 10, mtimeMs: Date.parse('2026-09-01T00:00:00Z'), isLink: false },
  }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.toast', async () => ({ value: undefined }))
  mock.store(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  // The engine's own band: an empty box the mod's tree replaces.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, { key: 'engine-band' }) as RenderElement)
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } }
  })
}
