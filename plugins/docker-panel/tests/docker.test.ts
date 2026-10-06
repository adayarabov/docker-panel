import { describe, expect, test, tier } from 'claude-code/testing'

import { resolveProjectDir } from '../hooks/docker'

tier('user')

describe('docker', () => {
  test('resolves relative, absolute and dotted project directories', async () => {
    expect(resolveProjectDir('/repo', 'examples/shop-demo')).toBe('/repo/examples/shop-demo')
    expect(resolveProjectDir('/repo', './examples/shop-demo/')).toBe('/repo/examples/shop-demo')
    expect(resolveProjectDir('/repo', '../other')).toBe('/other')
    expect(resolveProjectDir('/repo', '/srv/app')).toBe('/srv/app')
    expect(resolveProjectDir('/repo', '')).toBe('/repo')
    expect(resolveProjectDir('/repo', '.')).toBe('/repo')
  })
})
