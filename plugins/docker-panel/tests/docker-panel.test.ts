import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'

import { actionsFor } from '../hooks/actions'
import { buildSnapshot, failureText, newFailures, parsePs, severityOf } from '../hooks/compose'
import type { Inputs } from '../hooks/compose'
import { resolveProjectDir } from '../hooks/docker'

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

type World = {
  ps: string[]
  hashes: Record<string, string>
  restarts: number
  isDaemonDown?: boolean
  /** While set, compose actions (stop, restart, up…) wait on it, so a test can look mid-action. */
  actionGate?: Promise<void>
}

const DAEMON_DOWN =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'

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
    if (joined.startsWith('info')) {
      if (world.current.isDaemonDown) {
        return { value: { exitCode: 1, stdout: '', stderr: DAEMON_DOWN, isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return ok('29.0.0')
    }
    if (joined === 'compose config --format json') return ok(CONFIG)
    if (joined.startsWith('compose config --hash')) {
      return ok(Object.entries(world.current.hashes).map(([s, h]) => `${s} ${h}`).join('\n'))
    }
    if (joined.startsWith('compose ps')) return ok(world.current.ps.join('\n'))
    if (args[0] === 'inspect') {
      return ok(args.slice(3).map(id => `${id}ffff|${world.current.restarts}|sha256:img`).join('\n'))
    }
    if (args[0] === 'image') return ok('sha256:img|2026-10-01T00:00:00Z')
    if (args[0] === 'compose' && ['stop', 'restart', 'up', 'down'].includes(args[1] ?? '')) {
      await world.current.actionGate
      return ok('')
    }
    if (joined.startsWith('compose logs')) return ok('Error: password authentication failed for user "shop"')
    if (args[0] === 'stats') {
      return ok(
        args
          .slice(4)
          .map(id => JSON.stringify({ ID: id, CPUPerc: '1.50%', MemUsage: '100MiB / 15GiB' }))
          .join('\n'),
      )
    }
    return ok('')
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
        { name: 'web', buildDockerfile: null, image: 'node:22-alpine' },
        { name: 'api', buildDockerfile: `${CWD}/api/Dockerfile`, image: null },
        { name: 'db', buildDockerfile: null, image: 'postgres:16' },
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

  test('a stop that docker had to finish with SIGKILL is a stop, not a crash', async () => {
    const stopped = healthy()
    stopped.ps[0] = psLine({ id: 'aaaaaaaaaaaa', service: 'web', state: 'exited', exit: 137 })
    stopped.ps[2] = psLine({ id: 'cccccccccccc', service: 'db', state: 'exited', exit: 143 })
    const snap = buildSnapshot(inputs(stopped))
    expect(snap.services.find(s => s.name === 'web')?.status).toBe('stopped')
    expect(snap.services.find(s => s.name === 'db')?.status).toBe('stopped')
    expect(severityOf(snap)).toBe('ok')
    expect(actionsFor(snap)[0]?.label).not.toBe('Ask Claude')
  })

  test('a SIGKILL from the out-of-memory killer is a crash', async () => {
    const oom = healthy()
    oom.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 137 })
    const snap = buildSnapshot({
      ...inputs(oom),
      facts: { bbbbbbbbbbbb: { restarts: 0, imageId: 'sha256:img', isOomKilled: true } },
    })
    const api = snap.services.find(s => s.name === 'api')!
    expect(api.status).toBe('exited')
    expect(severityOf(snap)).toBe('failing')
    expect(failureText(api)).toBe('api was killed: out of memory')
  })

  test('with nothing running the band offers ▶ up and ⚒ up --build', async () => {
    const down = healthy()
    down.ps = down.ps.map((_, i) =>
      psLine({ id: `${i}`.repeat(12), service: ['web', 'api', 'db'][i]!, state: 'exited', exit: 0 }),
    )
    const snap = buildSnapshot(inputs(down))
    expect(severityOf(snap)).toBe('down')
    expect(actionsFor(snap).map(a => [a.label, a.hotkey])).toEqual([
      ['▶', 'u'],
      ['⚒', 'b'],
      ['More', 'm'],
    ])
    expect(actionsFor(snap)[1]?.run).toEqual({ kind: 'compose', args: ['up', '-d', '--build'], busy: 'building and starting' })
  })

  test('a crash is reported once, and again only when restarts grow', async () => {
    const before = buildSnapshot(inputs(healthy()))
    const crashed = healthy()
    crashed.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 1 })
    const after = buildSnapshot(inputs(crashed))
    expect(newFailures(before, after)).toEqual(['api exited with code 1'])
    expect(newFailures(after, after)).toEqual([])
    expect(actionsFor(after).map(a => a.key)).toEqual(['ask', 'restart', 'more'])
  })
})

describe('project directory', () => {
  test('resolves relative, absolute and dotted paths', async () => {
    expect(resolveProjectDir('/repo', 'examples/shop-demo')).toBe('/repo/examples/shop-demo')
    expect(resolveProjectDir('/repo', './examples/shop-demo/')).toBe('/repo/examples/shop-demo')
    expect(resolveProjectDir('/repo', '../other')).toBe('/other')
    expect(resolveProjectDir('/repo', '/srv/app')).toBe('/srv/app')
    expect(resolveProjectDir('/repo', '')).toBe('/repo')
    expect(resolveProjectDir('/repo', '.')).toBe('/repo')
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
      // Ports live in the control pane's cards; the band's chips stay short.
      expect((await ui.find({ key: 'chip-web' }))?.text).not.toContain('3000')
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-')).map(b => b.props.label)).toEqual(['↻', '■', 'More'])
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
    expect(buttons.map(b => b.props.label)).toEqual(['Ask Claude', 'Restart api', 'More'])
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
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-')).map(b => b.props.label)).toEqual(['↻', '■', 'More'])
  })

  test('the desktop × hides the band; the terminal leaves that to its own [-]', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const panel = (args: string) =>
      $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

    const terminal = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    expect(await terminal.find({ key: 'close' })).toBeUndefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ plugin: 'docker-panel', surface: 'desktop', ...BAND })
    await desktop.press({ key: 'close' })
    expect(await desktop.find({ key: 'chip-web' })).toBeUndefined()
    expect((await panel('show')).text).toContain('shown')
    expect(await desktop.find({ key: 'chip-web' })).toBeDefined()
    await desktop.unmount()
  })

  test('/docker-panel hide and show work on every surface', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const panel = (args: string) =>
      $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'docker-panel', surface, ...BAND })
      expect((await panel('hide')).text).toContain('hidden')
      expect(await ui.find({ key: 'chip-web' })).toBeUndefined()
      expect((await panel('show')).text).toContain('shown')
      expect(await ui.find({ key: 'chip-web' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('/docker-panel use points the band at a compose project in a subdirectory', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    const panel = (args: string) =>
      $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

    expect(await ui.find({ key: 'chip-web' })).toBeUndefined()
    expect((await panel('use nowhere')).text).toBe('No compose file in /work/nowhere.')
    expect((await panel('use ./shop')).text).toBe(`The Docker band now follows ${CWD}/compose.yaml.`)
    expect(await ui.find({ key: 'chip-web' })).toBeDefined()
  })

  test('/docker logs falls back to the log tail where no pane can be placed', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    on('ui.open', async () => ({ value: { isPlaced: false, reason: 'narrow' } }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const out = await $.command.run({ command: 'docker', args: 'logs api' } as Parameters<typeof $.command.run>[0])
    expect(out.text).toContain('password authentication failed')
  })

  test('answers its commands under the plugin-prefixed name too', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const out = await $.command.run({ command: 'docker-panel:docker', args: '' } as Parameters<typeof $.command.run>[0])
    expect(out.text).toContain('- web: Up 2 hours :3000')
  })

  test('row one sums up the project; the chips start on row two', async ($, on) => {
    const clock = mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'docker-panel', surface: 'desktop', ...BAND })
    const summary = await ui.find({ key: 'summary' })
    expect(summary?.text).toContain('shop')
    expect(summary?.text).toContain('3/3 up')
    expect(summary?.text).toContain('CPU 4.5% · RAM 300M')
    expect((await ui.find({ key: 'services' }))?.text).toContain('web')
  })

  test('More opens the control pane: a card per service with its own buttons and logs', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    fakeDocker(on, { current: healthy() }, ran)
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    await band.press({ key: 'act-more' })
    expect(opened).toEqual(['docker-control'])

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({
        plugin: 'docker-panel',
        surface,
        component: 'Pane',
        requestId: 'docker-control',
        props: {} as never,
      })
      for (const name of ['web', 'api', 'db']) expect(await pane.find({ key: `card-${name}` })).toBeDefined()
      expect((await pane.find({ key: 'card-web' }))?.text).toContain('localhost:3000')
      expect(await pane.find({ key: 'stop-api' })).toBeDefined()
      expect(await pane.find({ key: 'rebuild-api' })).toBeDefined()
      expect(await pane.find({ key: 'rebuild-web' })).toBeUndefined()

      await pane.press({ key: 'logs-api' })
      expect((await pane.find({ key: 'card-api' }))?.text).toContain('password authentication failed')
      await pane.press({ key: 'logs-api' })
      expect((await pane.find({ key: 'card-api' }))?.text).not.toContain('password authentication failed')
      await pane.unmount()
    }

    const pane = await $.ui.mount({
      plugin: 'docker-panel',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'docker-control',
      props: {} as never,
    })
    await pane.press({ key: 'stop-web' })
    await clock.settle()
    expect(ran.some(args => args.join(' ') === 'compose stop web')).toBe(true)
  })

  test('a daemon that comes back clears its error from the band and the pane', async ($, on) => {
    mock.clock(on)
    const world: { current: World } = { current: { ...healthy(), isDaemonDown: true } }
    fakeDocker(on, world, [])
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const docker = (args: string) => $.command.run({ command: 'docker', args } as Parameters<typeof $.command.run>[0])

    const band = await $.ui.mount({ plugin: 'docker-panel', surface: 'desktop', ...BAND })
    expect(await band.find({ type: 'Text', text: /Cannot connect/ })).toBeDefined()

    world.current = healthy()
    await docker('status')
    expect(await band.find({ type: 'Text', text: /Cannot connect/ })).toBeUndefined()
    expect(await band.find({ key: 'chip-web' })).toBeDefined()

    await docker('more')
    const pane = await $.ui.mount({
      plugin: 'docker-panel',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'docker-control',
      props: {} as never,
    })
    expect(await pane.find({ type: 'Text', text: /Cannot connect/ })).toBeUndefined()
  })

  test('a card being stopped says so, on its own card and chip only', async ($, on) => {
    const clock = mock.clock(on)
    let release = () => {}
    const world: { current: World } = { current: { ...healthy(), actionGate: new Promise(r => (release = r)) } }
    fakeDocker(on, world, [])
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    const pane = await $.ui.mount({
      plugin: 'docker-panel',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'docker-control',
      props: {} as never,
    })

    await pane.press({ key: 'stop-web' })
    await clock.settle()
    expect((await pane.find({ key: 'card-web' }))?.text).toContain('stopping…')
    expect(await pane.find({ key: 'stop-web' })).toBeUndefined()
    expect((await pane.find({ key: 'card-api' }))?.text).not.toContain('stopping…')
    expect((await band.find({ key: 'chip-web' }))?.text).toContain('stopping…')

    release()
    await clock.settle()
    expect((await pane.find({ key: 'card-web' }))?.text).not.toContain('stopping…')
  })

  test('More becomes Less while the pane is open, and Less closes it', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    const closed: string[] = []
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('ui.close', async (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'docker-panel', surface: 'desktop', ...BAND })
    const label = async () => (await band.find({ key: 'act-more' }))?.props.label

    expect(await label()).toBe('More')
    await band.press({ key: 'act-more' })
    expect(await label()).toBe('Less')
    await band.press({ key: 'act-more' })
    expect(closed).toEqual(['docker-control'])
    expect(await label()).toBe('More')
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
