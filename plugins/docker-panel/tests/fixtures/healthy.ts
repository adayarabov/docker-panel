import { CONFIG_HASH } from './config-hash'
import { psLine } from './ps-line'
import type { World } from './world'

/** Three services up: web on :3000, api healthy on :8080, db with no port. */
export function healthy(): World {
  return {
    ps: [
      psLine({ id: 'aaaaaaaaaaaa', service: 'web', state: 'running', port: 3000 }),
      psLine({ id: 'bbbbbbbbbbbb', service: 'api', state: 'running', health: 'healthy', port: 8080 }),
      psLine({ id: 'cccccccccccc', service: 'db', state: 'running' }),
    ],
    hashes: { web: CONFIG_HASH.old, api: CONFIG_HASH.old, db: CONFIG_HASH.old },
    restarts: 0,
  }
}
