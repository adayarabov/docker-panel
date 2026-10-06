import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { BAND } from './fixtures/band-site'
import { CWD } from './fixtures/cwd'
import { fakeDocker } from './fixtures/fake-docker'
import { healthy } from './fixtures/healthy'
import { PANE } from './fixtures/pane-site'
import type { World } from './fixtures/world'

tier('user')

describe('pane', () => {
  test('a card per service with its ports, its own buttons and its logs on demand', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    fakeDocker(on, { current: healthy() }, ran)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'docker-panel', surface, ...PANE })
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

    const pane = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...PANE })
    await pane.press({ key: 'stop-web' })
    await clock.settle()
    expect(ran.some(args => args.join(' ') === 'compose stop web')).toBe(true)
  })

  test('a card being stopped says so, on its own card and chip only', async ($, on) => {
    const clock = mock.clock(on)
    let release = () => {}
    const world: { current: World } = { current: { ...healthy(), actionGate: new Promise(r => (release = r)) } }
    fakeDocker(on, world, [])
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...BAND })
    const pane = await $.ui.mount({ plugin: 'docker-panel', surface: 'terminal', ...PANE })

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
})
