// Which buttons the band and the control pane offer, and what each one does.
import type { Service, Snapshot } from '../types'
import { failureText, isFailing, isRunning, severityOf, staleServices } from './compose'

export type ActionRun =
  /** `service` names the one service the action is about; absent for the whole stack. */
  | { kind: 'compose'; args: string[]; busy: string; service?: string; verb?: string }
  | { kind: 'ask'; service: string }
  /** Opens the control pane, with `service`'s logs unfolded when one is named. */
  | { kind: 'more'; service: string | null }
  /** Closes the control pane. */
  | { kind: 'less' }

export type Action = {
  key: string
  label: string
  hotkey?: string
  isPrimary: boolean
  run: ActionRun
}

const compose = (args: string[], busy: string): ActionRun => ({ kind: 'compose', args, busy })
const up = (extra: string[], busy: string): ActionRun => compose(['up', '-d', ...extra], busy)

/** A compose action on one service: `verb` ("stopping") is what its card shows meanwhile. */
const onService = (service: string, args: string[], verb: string): ActionRun => ({
  kind: 'compose',
  args: [...args, service],
  busy: `${verb} ${service}`,
  service,
  verb,
})

export type BandContext = {
  /** The control pane is open: More becomes Less and closes it. */
  isPaneOpen: boolean
}

/** The band's buttons: the one thing to do now, the stack-wide basics, and More (or Less). */
export function actionsFor(snapshot: Snapshot, context: BandContext = { isPaneOpen: false }): Action[] {
  const severity = severityOf(snapshot)
  const more = (service: string | null): Action =>
    context.isPaneOpen
      ? { key: 'more', label: 'Less', hotkey: 'm', isPrimary: false, run: { kind: 'less' } }
      : { key: 'more', label: 'More', hotkey: 'm', isPrimary: false, run: { kind: 'more', service } }

  if (severity === 'failing') {
    const failing = snapshot.services.find(isFailing)!.name
    return [
      { key: 'ask', label: 'Ask Claude', hotkey: 'a', isPrimary: true, run: { kind: 'ask', service: failing } },
      {
        key: 'restart',
        label: `Restart ${failing}`,
        hotkey: 'r',
        isPrimary: false,
        run: onService(failing, ['restart'], 'restarting'),
      },
      more(failing),
    ]
  }

  if (severity === 'down') {
    return [
      { key: 'up', label: '▶', hotkey: 'u', isPrimary: true, run: up([], 'starting') },
      { key: 'up-build', label: '⚒', hotkey: 'b', isPrimary: false, run: up(['--build'], 'building and starting') },
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

  // Stack-wide Restart and Down as glyphs: the band's first row stays short. The
  // control pane spells them out ("Restart all", "Down").
  return [
    { key: 'restart', label: '↻', hotkey: 'r', isPrimary: false, run: compose(['restart'], 'restarting') },
    { key: 'down', label: '■', hotkey: 'd', isPrimary: false, run: compose(['down'], 'stopping') },
    more(null),
  ]
}

/** One service card's buttons in the control pane. Logs is the pane's own toggle, not listed here. */
export function serviceActions(service: Service): Action[] {
  const name = service.name
  const actions: Action[] = []
  if (isFailing(service)) {
    actions.push({ key: `ask-${name}`, label: 'Ask Claude', isPrimary: true, run: { kind: 'ask', service: name } })
  }
  if (isRunning(service)) {
    actions.push(
      { key: `stop-${name}`, label: 'Stop', isPrimary: false, run: onService(name, ['stop'], 'stopping') },
      { key: `restart-${name}`, label: 'Restart', isPrimary: false, run: onService(name, ['restart'], 'restarting') },
    )
  } else {
    actions.push({ key: `start-${name}`, label: 'Start', isPrimary: !isFailing(service), run: onService(name, ['up', '-d'], 'starting') })
  }
  if (service.hasBuild) {
    actions.push({
      key: `rebuild-${name}`,
      label: 'Rebuild',
      isPrimary: service.stale !== null,
      run: onService(name, ['up', '-d', '--build'], 'rebuilding'),
    })
  } else if (service.stale) {
    actions.push({ key: `recreate-${name}`, label: 'Recreate', isPrimary: true, run: onService(name, ['up', '-d'], 'recreating') })
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
      return service ? onService(service, ['up', '-d'], 'starting') : up([], 'starting')
    case 'stop':
      return service ? onService(service, ['stop'], 'stopping') : compose(['stop'], 'stopping')
    case 'rebuild':
      return up(['--build', ...(service ? target : snapshot ? staleServices(snapshot) : [])], 'rebuilding')
    case 'restart':
      return service ? onService(service, ['restart'], 'restarting') : compose(['restart'], 'restarting')
    case 'down':
      return compose(['down'], 'stopping')
    case 'logs':
    case 'more':
      return { kind: 'more', service: service ?? null }
    default:
      return null
  }
}
