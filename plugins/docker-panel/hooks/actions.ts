// Which buttons the band offers for a snapshot, and what each one does.
import type { Snapshot } from '../types'
import { failureText, isFailing, severityOf, staleServices } from './compose'

export type ActionRun =
  | { kind: 'compose'; args: string[]; busy: string }
  | { kind: 'ask'; service: string }
  | { kind: 'logs'; service: string | null }

export type Action = {
  key: string
  label: string
  hotkey: string
  isPrimary: boolean
  run: ActionRun
}

const up = (extra: string[], busy: string): ActionRun => ({ kind: 'compose', args: ['up', '-d', ...extra], busy })

export function actionsFor(snapshot: Snapshot): Action[] {
  const severity = severityOf(snapshot)

  if (severity === 'failing') {
    const failing = snapshot.services.find(isFailing)!.name
    return [
      { key: 'ask', label: 'Ask Claude', hotkey: 'a', isPrimary: true, run: { kind: 'ask', service: failing } },
      { key: 'logs', label: `Logs ${failing}`, hotkey: 'l', isPrimary: false, run: { kind: 'logs', service: failing } },
      {
        key: 'restart',
        label: `Restart ${failing}`,
        hotkey: 'r',
        isPrimary: false,
        run: { kind: 'compose', args: ['restart', failing], busy: `restarting ${failing}` },
      },
    ]
  }

  if (severity === 'down') {
    return [
      { key: 'up', label: 'Up', hotkey: 'u', isPrimary: true, run: up([], 'starting') },
      { key: 'up-build', label: 'Up --build', hotkey: 'b', isPrimary: false, run: up(['--build'], 'building and starting') },
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
      { key: 'logs', label: 'Logs', hotkey: 'l', isPrimary: false, run: { kind: 'logs', service: null } },
    ]
  }

  return [
    { key: 'logs', label: 'Logs', hotkey: 'l', isPrimary: false, run: { kind: 'logs', service: null } },
    {
      key: 'restart',
      label: 'Restart',
      hotkey: 'r',
      isPrimary: false,
      run: { kind: 'compose', args: ['restart'], busy: 'restarting' },
    },
    {
      key: 'down',
      label: 'Down',
      hotkey: 'd',
      isPrimary: false,
      run: { kind: 'compose', args: ['down'], busy: 'stopping' },
    },
  ]
}

/** The note drawn beside the buttons; null when everything is fine. */
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
    case 'rebuild':
      return up(['--build', ...(service ? target : snapshot ? staleServices(snapshot) : [])], 'rebuilding')
    case 'restart':
      return { kind: 'compose', args: ['restart', ...target], busy: `restarting ${service ?? ''}`.trim() }
    case 'down':
      return { kind: 'compose', args: ['down'], busy: 'stopping' }
    case 'logs':
      return { kind: 'logs', service: service ?? null }
    default:
      return null
  }
}
