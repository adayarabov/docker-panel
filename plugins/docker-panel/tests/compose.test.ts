import { describe, expect, test, tier } from 'claude-code/testing'

import { buildSnapshot, failureText, newFailures, severityOf } from '../hooks/compose'
import { CONFIG_HASH } from './fixtures/config-hash'
import { healthy } from './fixtures/healthy'
import { inputsOf } from './fixtures/inputs-of'
import { psLine } from './fixtures/ps-line'

tier('user')

describe('compose', () => {
  test('deduplicates published ports and reads health', async () => {
    const snap = buildSnapshot(inputsOf(healthy()))
    expect(snap.services.map(s => [s.name, s.status, s.ports])).toEqual([
      ['web', 'running', [3000]],
      ['api', 'healthy', [8080]],
      ['db', 'running', []],
    ])
    expect(severityOf(snap)).toBe('ok')
  })

  test('a config hash that moved marks the service stale', async () => {
    const snap = buildSnapshot(inputsOf({ ...healthy(), hashes: { ...healthy().hashes, api: CONFIG_HASH.new } }))
    expect(snap.services.find(s => s.name === 'api')?.stale).toBe('config')
    expect(severityOf(snap)).toBe('stale')
  })

  test('a stop that docker had to finish with SIGKILL is a stop, not a crash', async () => {
    const stopped = healthy()
    stopped.ps[0] = psLine({ id: 'aaaaaaaaaaaa', service: 'web', state: 'exited', exit: 137 })
    stopped.ps[2] = psLine({ id: 'cccccccccccc', service: 'db', state: 'exited', exit: 143 })
    const snap = buildSnapshot(inputsOf(stopped))
    expect(snap.services.find(s => s.name === 'web')?.status).toBe('stopped')
    expect(snap.services.find(s => s.name === 'db')?.status).toBe('stopped')
    expect(severityOf(snap)).toBe('ok')
  })

  test('a SIGKILL from the out-of-memory killer is a crash', async () => {
    const oom = healthy()
    oom.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 137 })
    const snap = buildSnapshot({
      ...inputsOf(oom),
      facts: { bbbbbbbbbbbb: { restarts: 0, imageId: 'sha256:img', isOomKilled: true } },
    })
    const api = snap.services.find(s => s.name === 'api')!
    expect(api.status).toBe('exited')
    expect(severityOf(snap)).toBe('failing')
    expect(failureText(api)).toBe('api was killed: out of memory')
  })

  test('with every service exited cleanly the stack is down', async () => {
    const down = healthy()
    down.ps = down.ps.map((_, i) =>
      psLine({ id: `${i}`.repeat(12), service: ['web', 'api', 'db'][i]!, state: 'exited', exit: 0 }),
    )
    expect(severityOf(buildSnapshot(inputsOf(down)))).toBe('down')
  })

  test('a crash is reported once, and again only when restarts grow', async () => {
    const before = buildSnapshot(inputsOf(healthy()))
    const crashed = healthy()
    crashed.ps[1] = psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'exited', exit: 1 })
    const after = buildSnapshot(inputsOf(crashed))
    expect(newFailures(before, after)).toEqual(['api exited with code 1'])
    expect(newFailures(after, after)).toEqual([])
  })
})
