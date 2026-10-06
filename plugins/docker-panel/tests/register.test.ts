import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { BAND } from './fixtures/band-site'
import { CWD } from './fixtures/cwd'
import { fakeDocker } from './fixtures/fake-docker'
import { healthy } from './fixtures/healthy'
import { PANE } from './fixtures/pane-site'
import { psLine } from './fixtures/ps-line'
import type { World } from './fixtures/world'

tier('user')

describe('register', () => {
  test('Restart runs compose for the failing service off a timer, then refreshes', async ($, on) => {
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
    const actions = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('act-'))
    expect(actions.map(b => b.props.label)).toEqual(['↻', '■', 'More'])
  })

  test('/docker-panel hide and show work on every surface', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const panel = (args: string) => $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

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
    const panel = (args: string) => $.command.run({ command: 'docker-panel', args } as Parameters<typeof $.command.run>[0])

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
    const pane = await $.ui.mount({ plugin: 'docker-panel', surface: 'desktop', ...PANE })
    expect(await pane.find({ type: 'Text', text: /Cannot connect/ })).toBeUndefined()
  })

  test('More opens the pane and becomes Less; Less closes it', async ($, on) => {
    mock.clock(on)
    fakeDocker(on, { current: healthy() }, [])
    const opened: string[] = []
    const closed: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('ui.close', async (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'docker-panel', surface: 'desktop', ...BAND })
    const label = async () => (await band.find({ key: 'act-more' }))?.props.label

    expect(await label()).toBe('More')
    await band.press({ key: 'act-more' })
    expect(opened).toEqual(['docker-control'])
    expect(await label()).toBe('Less')
    await band.press({ key: 'act-more' })
    expect(closed).toEqual(['docker-control'])
    expect(await label()).toBe('More')
  })
})
