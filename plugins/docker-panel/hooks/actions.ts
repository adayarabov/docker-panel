// Which buttons the band and the control pane offer, and what each one does.
import type { Service, Snapshot } from '../types'
import { failureText, isFailing, severityOf, staleServices } from './compose'

export type ActionRun =
  | { kind: 'compose'; args: string[]; busy: string }
  | { kind: 'ask'; service: string }
  /** Opens the control pane, with `service`'s logs unfolded when one is named. */
  | { kind: 'more'; service: string | null }

export type Action = {
  key: string
  label: string
  hotkey?: string
  isPrimary: boolean
  run: ActionRun
}

const compose = (args: string[], busy: string): ActionRun => ({ kind: 'compose', args, busy })
const up = (extra: string[], busy: string): ActionRun => compose(['up', '-d', ...extra], busy)

const more = (service: string | null): Action => ({
  key: 'more',
  label: 'More',
  hotkey: 'm',
  isPrimary: false,
  run: { kind: 'more', service },
})

/** The band's buttons: the one thing to do now, the stack-wide basics, and More. */
export function actionsFor(snapshot: Snapshot): Action[] {
  const severity = severityOf(snapshot)

  if (severity === 'failing') {
    const failing = snapshot.services.find(isFailing)!.name
    return [
      { key: 'ask', label: 'Ask Claude', hotkey: 'a', isPrimary: true, run: { kind: 'ask', service: failing } },
      {
        key: 'restart',
        label: `Restart ${failing}`,
        hotkey: 'r',
        isPrimary: false,
        run: compose(['restart', failing], `restarting ${failing}`),
      },
      more(failing),
    ]
  }

  if (severity === 'down') {
    return [
      { key: 'up', label: 'Up', hotkey: 'u', isPrimary: true, run: up([], 'starting') },
      { key: 'up-build', label: 'Up --build', hotkey: 'b', isPrimary: false, run: up(['--build'], 'building and starting') },
      more(null),
    ]
  }

  if (severity === 'stale') {
    const stale = staleServices(snapshot)
    return [
      {
        key: 'rebuild',
        label: 'Rebuild & up',
        hotkey: 'b',
        isPrimary: true,
        run: up(['--build', ...stale], `rebuilding ${stale.join(', ')}`),
      },
      more(null),
    ]
  }

  return [
    { key: 'restart', label: 'Restart', hotkey: 'r', isPrimary: false, run: compose(['restart'], 'restarting') },
    { key: 'down', label: 'Down', hotkey: 'd', isPrimary: false, run: compose(['down'], 'stopping') },
    more(null),
  ]
}

const isRunning = (service: Service): boolean =>
  ['healthy', 'running', 'starting', 'unhealthy', 'restarting'].includes(service.status)

/** One service card's buttons in the control pane. Logs is the pane's own toggle, not listed here. */
export function serviceActions(service: Service): Action[] {
  const name = service.name
  const actions: Action[] = []
  if (isFailing(service)) {
    actions.push({ key: `ask-${name}`, label: 'Ask Claude', isPrimary: true, run: { kind: 'ask', service: name } })
  }
  if (isRunning(service)) {
    actions.push(
      { key: `stop-${name}`, label: 'Stop', isPrimary: false, run: compose(['stop', name], `stopping ${name}`) },
      { key: `restart-${name}`, label: 'Restart', isPrimary: false, run: compose(['restart', name], `restarting ${name}`) },
    )
  } else {
    actions.push({ key: `start-${name}`, label: 'Start', isPrimary: !isFailing(service), run: up([name], `starting ${name}`) })
  }
  if (service.hasBuild) {
    actions.push({
      key: `rebuild-${name}`,
      label: 'Rebuild',
      isPrimary: service.stale !== null,
      run: up(['--build', name], `rebuilding ${name}`),
    })
  } else if (service.stale) {
    actions.push({ key: `recreate-${name}`, label: 'Recreate', isPrimary: true, run: up([name], `recreating ${name}`) })
  }
  return actions
}

/** The note drawn on the band's first row; null when everything is fine. */
export function noteFor(snapshot: Snapshot): string | null {
  const severity = severityOf(snapshot)
  if (severity === 'failing') return failureText(snapshot.services.find(isFailing)!)
  if (severity === 'stale') return `config changed: ${staleServices(snapshot).join(', ')}`
  if (severity === 'down') return 'containers are not running'
  return null
}

/** The prompt "Ask Claude" puts in the box: what failed and the evidence. */
export function askPrompt(snapshot: Snapshot, serviceName: string): string {
  const service = snapshot.services.find(s => s.name === serviceName)
  if (!service) return `Check the \`${serviceName}\` service of compose project \`${snapshot.project}\`.`
  const logs = service.logTail.length ? `\n\nLast log lines:\n\`\`\`\n${service.logTail.join('\n')}\n\`\`\`` : ''
  return (
    `In compose project \`${snapshot.project}\` (${snapshot.file}), ${failureText(service)}.` +
    `${logs}\n\nFind the cause and fix it.`
  )
}

/** Parses `/docker <args>` into a run; null for status or anything unknown. */
export function commandRun(args: string, snapshot: Snapshot | null): ActionRun | null {
  const [verb, service] = args.trim().split(/\s+/)
  const target = service ? [service] : []
  switch (verb) {
    case 'up':
      return up(target, 'starting')
    case 'start':
      return up(target, `starting ${service ?? ''}`.trim())
    case 'stop':
      return compose(['stop', ...target], `stopping ${service ?? ''}`.trim())
    case 'rebuild':
      return up(['--build', ...(service ? target : snapshot ? staleServices(snapshot) : [])], 'rebuilding')
    case 'restart':
      return compose(['restart', ...target], `restarting ${service ?? ''}`.trim())
    case 'down':
      return compose(['down'], 'stopping')
    case 'logs':
    case 'more':
      return { kind: 'more', service: service ?? null }
    default:
      return null
  }
}
