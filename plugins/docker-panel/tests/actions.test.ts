import { describe, expect, test, tier } from 'claude-code/testing'

import { actionsFor, commandRun, serviceActions } from '../hooks/actions'
import { buildSnapshot } from '../hooks/compose'
import { CONFIG_HASH } from './fixtures/config-hash'
import { healthy } from './fixtures/healthy'
import { inputsOf } from './fixtures/inputs-of'
import { psLine } from './fixtures/ps-line'

tier('user')

describe('actions', () => {
  test('a healthy stack offers ↻ restart, ■ down and More; Less while the pane is open', async () => {
    const snap = buildSnapshot(inputsOf(healthy()))
    expect(actionsFor(snap).map(a => [a.label, a.hotkey])).toEqual([
      ['↻', 'r'],
      ['■', 'd'],
      ['More', 'm'],
    ])
    expect(actionsFor(snap, { isPaneOpen: true }).at(-1)).toMatchObject({ label: 'Less', run: { kind: 'less' } })
  })

  test('with nothing running the band offers ▶ up and ⚒ up --build', async () => {
    const down = healthy()
    down.ps = down.ps.map((_, i) =>
      psLine({ id: `${i}`.repeat(12), service: ['web', 'api', 'db'][i]!, state: 'exited', exit: 0 }),
    )
    const actions = actionsFor(buildSnapshot(inputsOf(down)))
    expect(actions.map(a => [a.label, a.hotkey])).toEqual([
      ['▶', 'u'],
      ['⚒', 'b'],
      ['More', 'm'],
    ])
    expect(actions[1]?.run).toEqual({ kind: 'compose', args: ['up', '-d', '--build'], busy: 'building and starting' })
  })

  test('a stale service is rebuilt by itself', async () => {
    const snap = buildSnapshot(inputsOf({ ...healthy(), hashes: { ...healthy().hashes, api: CONFIG_HASH.new } }))
    expect(actionsFor(snap)[0]?.run).toEqual({
      kind: 'compose',
      args: ['up', '-d', '--build', 'api'],
      busy: 'rebuilding api',
    })
  })

  test('a crash puts Ask Claude first; a stop does not', async () => {
    const crashed = healthy()
    crashed.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 1 })
    expect(actionsFor(buildSnapshot(inputsOf(crashed))).map(a => a.key)).toEqual(['ask', 'restart', 'more'])

    const stopped = healthy()
    stopped.ps[0] = psLine({ id: 'aaaaaaaaaaaa', service: 'web', state: 'exited', exit: 137 })
    expect(actionsFor(buildSnapshot(inputsOf(stopped)))[0]?.label).not.toBe('Ask Claude')
  })

  test('a card offers Stop and Restart while up, Start once stopped, Rebuild where the file builds', async () => {
    const stopped = healthy()
    stopped.ps[0] = psLine({ id: 'aaaaaaaaaaaa', service: 'web', state: 'exited', exit: 137 })
    const services = buildSnapshot(inputsOf(stopped)).services
    const keys = (name: string) => serviceActions(services.find(s => s.name === name)!).map(a => a.key)
    expect(keys('web')).toEqual(['start-web'])
    expect(keys('api')).toEqual(['stop-api', 'restart-api', 'rebuild-api'])
    expect(serviceActions(services.find(s => s.name === 'api')!)[0]?.run).toEqual({
      kind: 'compose',
      args: ['stop', 'api'],
      busy: 'stopping api',
      service: 'api',
      verb: 'stopping',
    })
  })

  test('/docker arguments map onto compose runs', async () => {
    expect(commandRun('stop web', null)).toMatchObject({ args: ['stop', 'web'], service: 'web', verb: 'stopping' })
    expect(commandRun('logs api', null)).toEqual({ kind: 'more', service: 'api' })
    expect(commandRun('down', null)).toEqual({ kind: 'compose', args: ['down'], busy: 'stopping' })
    expect(commandRun('status', null)).toBeNull()
  })
})
