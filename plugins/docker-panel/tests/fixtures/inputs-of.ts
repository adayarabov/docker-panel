import type { Inputs } from '../../hooks/compose'
import { parsePs } from '../../hooks/compose'
import { CWD } from './cwd'
import type { World } from './world'

/** The pure derivation's inputs for a world: web and db from images, api built from a Dockerfile. */
export function inputsOf(world: World): Inputs {
  return {
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
  }
}
