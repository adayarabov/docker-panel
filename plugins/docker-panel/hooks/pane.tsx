// The control pane, docked beside the transcript: stack-wide actions on top,
// then one card per service with its own state, usage, ports and buttons, and
// its logs unfolded on demand. The pane's body scrolls when the cards outgrow it.
import type { RenderSurface } from 'claude-code'

import type { PaneView, Panel, Service, Stats } from '../types'
import type { Action } from './actions'
import { serviceActions } from './actions'
import type { Els } from './band'
import { COLOR, ERROR_LINE, glyphOf, statusColor } from './band'
import { formatUsage, isFailing, isRunning, upSummary } from './compose'

export const PANE_ID = 'docker-control'

/** Log lines an unfolded card shows. */
export const CARD_LOG_LINES = 12

export type PaneHandlers = {
  onAction: (action: Action) => void
  onToggleLogs: (service: string) => void
}

const STACK_ACTIONS: Action[] = [
  { key: 'stack-up', label: 'Up all', isPrimary: false, run: { kind: 'compose', args: ['up', '-d'], busy: 'starting' } },
  {
    key: 'stack-restart',
    label: 'Restart all',
    isPrimary: false,
    run: { kind: 'compose', args: ['restart'], busy: 'restarting' },
  },
  { key: 'stack-down', label: 'Down', isPrimary: false, run: { kind: 'compose', args: ['down'], busy: 'stopping' } },
]

function ActionButtons(els: Els, actions: Action[], onAction: (action: Action) => void) {
  const { Button } = els
  return actions.map(action => (
    <Button
      key={action.key}
      label={action.label}
      variant={action.isPrimary ? 'primary' : undefined}
      onPress={() => onAction(action)}
    />
  ))
}

function cardColor(service: Service): string {
  if (isFailing(service)) return COLOR.bad
  if (service.stale) return COLOR.warn
  return COLOR.frame
}

function Card(els: Els, service: Service, stats: Stats | null, view: PaneView, handlers: PaneHandlers) {
  const { Box, Text, Button, Link } = els
  // A stopped container's last sample (0%, a few KB) says nothing; show usage only while it runs.
  const usage = isRunning(service) ? stats?.byService[service.name] : undefined
  const isOpen = view.expanded.includes(service.name)
  const lines = view.logs[service.name] ?? []
  const notes = [
    service.restarts ? `↻ ${service.restarts} restarts` : null,
    service.stale === 'config' ? 'config changed since start' : null,
    service.stale === 'image' ? 'Dockerfile changed since build' : null,
  ].filter(Boolean)

  return (
    <Box key={`card-${service.name}`} flexDirection="column" borderStyle="round" borderColor={cardColor(service)} paddingX={1}>
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" flexShrink={1} minWidth={0} columnGap={1}>
          <Text color={statusColor(service)}>{glyphOf(service)}</Text>
          <Text bold>{service.name}</Text>
          <Text dimColor={!isFailing(service)} color={isFailing(service) ? COLOR.bad : undefined} wrap="truncate-end">
            {service.statusText}
          </Text>
        </Box>
        {usage && <Text dimColor>{formatUsage(usage)}</Text>}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {service.image && <Text dimColor>{service.image}</Text>}
        {service.ports.map(port => (
          <Link href={`http://localhost:${port}`}>{`localhost:${port}`}</Link>
        ))}
        {notes.length > 0 && <Text color={isFailing(service) ? COLOR.bad : COLOR.warn}>{notes.join(' · ')}</Text>}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {ActionButtons(els, serviceActions(service), handlers.onAction)}
        <Button
          key={`logs-${service.name}`}
          label={isOpen ? 'Hide logs' : 'Logs'}
          dimColor={!isOpen}
          onPress={() => handlers.onToggleLogs(service.name)}
        />
      </Box>
      {isOpen && lines.length === 0 && <Text dimColor>No log output yet.</Text>}
      {isOpen &&
        lines.slice(-CARD_LOG_LINES).map(line => {
          const isError = ERROR_LINE.test(line)
          return (
            <Text color={isError ? COLOR.bad : undefined} dimColor={!isError} wrap="truncate-end">
              {line}
            </Text>
          )
        })}
    </Box>
  )
}

export function drawPane(els: Els, surface: RenderSurface, panel: Panel, view: PaneView, handlers: PaneHandlers) {
  const { Box, Text } = els
  const snapshot = panel.snapshot
  if (!snapshot) return <Text dimColor>No compose project is being followed.</Text>

  // Card borders already separate cards in the terminal; a gap there costs two blank rows each.
  return (
    <Box flexDirection="column" rowGap={surface === 'terminal' ? 0 : 1}>
      <Box key="pane-head" flexDirection="column">
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          <Text bold color={COLOR.accent}>
            ⬢ {snapshot.project}
          </Text>
          <Text dimColor>{upSummary(snapshot)}</Text>
          {panel.stats && <Text dimColor>{formatUsage(panel.stats.total)}</Text>}
        </Box>
        <Text dimColor wrap="truncate-start">
          {snapshot.file}
        </Text>
        {panel.error && <Text color={COLOR.bad}>▲ {panel.error}</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {panel.busy ? (
            <Text color={COLOR.accent}>… {panel.busy}</Text>
          ) : (
            ActionButtons(els, STACK_ACTIONS, handlers.onAction)
          )}
        </Box>
      </Box>
      {snapshot.services.map(service => Card(els, service, panel.stats, view, handlers))}
    </Box>
  )
}
