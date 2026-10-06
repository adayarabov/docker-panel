import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'

import { actionsFor } from '../hooks/actions'
import { buildSnapshot, newFailures, parsePs, severityOf } from '../hooks/compose'
import type { Inputs } from '../hooks/compose'

const CWD = '/work/shop'
const HASH_OLD = 'a'.repeat(64)
const HASH_NEW = 'b'.repeat(64)

const psLine = (o: { id: string; service: string; state: string; health?: string; exit?: number; port?: number }) =>
  JSON.stringify({
    ID: o.id,
    Service: o.service,
    State: o.state,
    Health: o.health ?? '',
    ExitCode: o.exit ?? 0,
    Status: o.state === 'running' ? 'Up 2 hours' : `Exited (${o.exit ?? 0}) 5 seconds ago`,
    Publishers: o.port ? [{ PublishedPort: o.port }, { PublishedPort: o.port }] : [],
    Labels: `com.docker.compose.project=shop,com.docker.compose.config-hash=${HASH_OLD},com.docker.compose.service=${o.service}`,
  })

const CONFIG = JSON.stringify({
  name: 'shop',
  services: { web: {}, api: { build: { context: `${CWD}/api`, dockerfile: 'Dockerfile' } }, db: {} },
})

type World = { ps: string[]; hashes: Record<string, string>; restarts: number }

const healthy = (): World => ({
  ps: [
    psLine({ id: 'aaaaaaaaaaaa', service: 'web', state: 'running', port: 3000 }),
    psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'running', health: 'healthy', port: 8080 }),
    psLine({ id: 'cccccccccccc', service: 'db', state: 'running' }),
  ],
  hashes: { web: HASH_OLD, api: HASH_OLD, db: HASH_OLD },
  restarts: 0,
})

const ok = (stdout: string): { value: ProcessRunResult } => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Answers the docker CLI beneath the plugin from `world`, recording what ran. */
function fakeDocker(on: On, world: { current: World }, ran: string[][]) {
  on('process.run', async (_$, e) => {
    const args = [...e.argv].slice(1)
    ran.push(args)
    const joined = args.join(' ')
    if (joined.startsWith('info')) return ok('29.0.0')
    if (joined === 'compose config --format json') return ok(CONFIG)
    if (joined.startsWith('compose config --hash')) {
      return ok(Object.entries(world.current.hashes).map(([s, h]) => `${s} ${h}`).join('\n'))
    }
    if (joined.startsWith('compose ps')) return ok(world.current.ps.join('\n'))
    if (args[0] === 'inspect') {
      return ok(args.slice(3).map(id => `${id}ffff|${world.current.restarts}|sha256:img`).join('\n'))
    }
    if (args[0] === 'image') return ok('sha256:img|2026-10-01T00:00:00Z')
    if (joined.startsWith('compose logs')) return ok('Error: password authentication failed for user "shop"')
    return ok('')
  })
  on('fs.exists', async (_$, e) => ({ value: e.path === `${CWD}/compose.yaml` }))
  on('fs.stat', async () => ({
    value: { kind: 'file' as const, size: 10, mtimeMs: Date.parse('2026-09-01T00:00:00Z'), isLink: false },
  }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  mock.store(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  // The engine's own band: an empty box the plugin's tree replaces.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, { key: 'engine-band' }) as RenderElement)
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } }
  })
}

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
}

describe('snapshot derivation', () => {
  const inputs = (world: World): Inputs => ({
    config: {
      project: 'shop',
      services: [
        { name: 'web', buildDockerfile: null },
        { name: 'api', buildDockerfile: `${CWD}/api/Dockerfile` },
        { name: 'db', buildDockerfile: null },
      ],
    },
    file: 'compose.yaml',
    rows: parsePs(world.ps.join('\n')),
    hashes: world.hashes,
    facts: {},
    imageCreatedMs: {},
    dockerfileMtimeMs: {},
    logTails: {},
    checkedAt: 0,
  })

  test('deduplicates published ports and reads health', async () => {
    const snap = buildSnapshot(inputs(healthy()))
    expect(snap.services.map(s => [s.name, s.status, s.ports])).toEqual([
      ['web', 'running', [3000]],
      ['api', 'healthy', [8080]],
      ['db', 'running', []],
    ])
    expect(severityOf(snap)).toBe('ok')
  })

  test('a config hash that moved marks the service stale', async () => {
    const snap = buildSnapshot(inputs({ ...healthy(), hashes: { ...healthy().hashes, api: HASH_NEW } }))
    expect(snap.services.find(s => s.name === 'api')?.stale).toBe('config')
    expect(severityOf(snap)).toBe('stale')
    expect(actionsFor(snap)[0]?.run).toEqual({ kind: 'compose', args: ['up', '-d', '--build', 'api'], busy: 'rebuilding api' })
  })

  test('a crash is reported once, and again only when restarts grow', async () => {
    const before = buildSnapshot(inputs(healthy()))
    const crashed = healthy()
    crashed.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 1 })
    const after = buildSnapshot(inputs(crashed))
    expect(newFailures(before, after)).toEqual(['api exited with code 1'])
    expect(newFailures(after, after)).toEqual([])
    expect(actionsFor(after).map(a => a.key)).toEqual(['ask', 'logs', 'restart'])
  })
})

describe('band', () => {
  test('draws every service as a chip with its port, on terminal and desktop', async ($, on) => {
    mock.clock(on)
    const world = { current: healthy() }
    fakeDocker(on, world, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'docker-panel', surface, ...BAND })
      for (const name of ['web', 'api', 'db']) expect(await ui.find({ key: `chip-${name}` })).toBeDefined()
      expect((await ui.find({ key: 'chip-web' }))?.text).toContain('3000')
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-')).map(b => b.props.label)).toEqual(['Logs', 'Restart', 'Down'])
      // The desktop frames the band itself; only the terminal draws a border.
      const root = await ui.drawn()
      expect((root as { props?: Record<string, unknown> }).props?.borderStyle).toBe(surface === 'terminal' ? 'round' : undefined)
      await ui.unmount()
    }
  })

  test('a crashed service puts Ask Claude first and fills the prompt with its logs', async ($, on) => {
    mock.clock(on)
    const world = { current: healthy() }
    world.current.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 1 })
    world.current.restarts = 3
    fakeDocker(on, world, [])
    const filled: string[] = []
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    const buttons = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-'))
    expect(buttons.map(b => b.props.label)).toEqual(['Ask Claude', 'Logs api', 'Restart api'])
    expect((await ui.find({ key: 'chip-api' }))?.text).toContain('exited(1) ↻3')

    await ui.press({ key: 'act-ask' })
    expect(filled[0]).toContain('api exited with code 1, 3 restarts')
    expect(filled[0]).toContain('password authentication failed')
  })

  test('Restart runs compose for the failing service and refreshes', async ($, on) => {
    const clock = mock.clock(on)
    const world = { current: healthy() }
    world.current.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 1 })
    const ran: string[][] = []
    fakeDocker(on, world, ran)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    world.current = healthy()
    await ui.press({ key: 'act-restart' })
    await clock.settle()
    expect(ran.some(args => args.join(' ') === 'compose restart api')).toBe(true)
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-')).map(b => b.props.label)).toEqual(['Logs', 'Restart', 'Down'])
  })

  test('the corner × hides the band and /docker-panel show brings it back', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const panel = (args: string) =>
      $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'docker-panel', surface, ...BAND })
      await ui.press({ key: 'close' })
      expect(await ui.find({ key: 'chip-web' })).toBeUndefined()
      expect((await panel('show')).text).toContain('shown')
      expect(await ui.find({ key: 'chip-web' })).toBeDefined()
      expect((await panel('hide')).text).toContain('hidden')
      expect(await ui.find({ key: 'chip-web' })).toBeUndefined()
      await panel('show')
      await ui.unmount()
    }
  })

  test('stays out of the way without a compose file', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'chip-web' })).toBeUndefined()
    expect(await ui.find({ key: 'engine-band' })).toBeDefined()
  })
})
