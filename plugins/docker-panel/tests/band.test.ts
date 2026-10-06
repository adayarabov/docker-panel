import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { BAND } from './fixtures/band-site'
import { CWD } from './fixtures/cwd'
import { fakeDocker } from './fixtures/fake-docker'
import { healthy } from './fixtures/healthy'
import { psLine } from './fixtures/ps-line'

tier('user')

describe('band', () => {
  test('draws a chip per service and glyph actions, bordered only in the terminal', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'docker-panel', surface, ...BAND })
      for (const name of ['web', 'api', 'db']) expect(await ui.find({ key: `chip-${name}` })).toBeDefined()
      // Ports live in the control pane's cards; the band's chips stay short.
      expect((await ui.find({ key: 'chip-web' }))?.text).not.toContain('3000')
      const actions = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-'))
      expect(actions.map(b => b.props.label)).toEqual(['↻', '■', 'More'])
      // The desktop frames the band itself; only the terminal draws a border.
      const root = await ui.drawn()
      expect((root as { props?: Record<string, unknown> }).props?.borderStyle).toBe(
        surface === 'terminal' ? 'round' : undefined,
      )
      await ui.unmount()
    }
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
    const actions = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-'))
    expect(actions.map(b => b.props.label)).toEqual(['Ask Claude', 'Restart api', 'More'])
    expect((await ui.find({ key: 'chip-api' }))?.text).toContain('exited(1) ↻3')

    await ui.press({ key: 'act-ask' })
    expect(filled[0]).toContain('api exited with code 1, 3 restarts')
    expect(filled[0]).toContain('password authentication failed')
  })

  test('the desktop × hides the band; the terminal leaves that to its own [-]', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const panel = (args: string) => $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

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

  test('stays out of the way without a compose file', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'chip-web' })).toBeUndefined()
    expect(await ui.find({ key: 'engine-band' })).toBeDefined()
  })
})
