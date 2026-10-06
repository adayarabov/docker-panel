// The band above the prompt. Row one carries what matters at a glance (project,
// how many services are up, CPU/RAM, the problem if any, actions and ×); the
// service chips start on row two and wrap. Per-service detail and control live
// in the pane that More opens.
import type { Elements, RenderSurface } from 'claude-code'

import type { Panel, Service, ServiceStatus, Stats } from '../types'
import type { Action } from './actions'
import { actionsFor, noteFor } from './actions'
import { formatUsage, isFailing, isRunning, severityOf, upSummary } from './compose'

export type Els = Elements[RenderSurface]

export const COLOR = {
  ok: '#5ccf8a',
  warn: '#e8b64c',
  bad: '#f07070',
  idle: '#7b8290',
  accent: '#6ea2ff',
  frame: '#4a505c',
  chip: '#262a33',
}

const GLYPH: Record<ServiceStatus, string> = {
  healthy: '●',
  running: '●',
  starting: '◐',
  restarting: '✕',
  unhealthy: '✕',
  exited: '○',
  stopped: '○',
  created: '○',
  paused: '◌',
  absent: '○',
}

const MAX_LOG_LINE = 200
export const ERROR_LINE = /error|fatal|panic|exception|traceback/i

export function statusColor(service: Service): string {
  if (isFailing(service)) return COLOR.bad
  if (service.status === 'healthy' || service.status === 'running') return COLOR.ok
  if (service.status === 'starting') return COLOR.warn
  return COLOR.idle
}

export function glyphOf(service: Service): string {
  return isFailing(service) ? '✕' : GLYPH[service.status]
}

function chipDetail(service: Service): string | null {
  if (service.status === 'exited' && service.exitCode !== 0) {
    return service.restarts ? `exited(${service.exitCode}) ↻${service.restarts}` : `exited(${service.exitCode})`
  }
  if (service.status === 'unhealthy' || service.status === 'restarting' || service.status === 'starting') {
    return service.restarts ? `${service.status} ↻${service.restarts}` : service.status
  }
  if (service.stale) return 'stale'
  return null
}

function Chip(els: Els, surface: RenderSurface, service: Service) {
  const { Box, Text, Link } = els
  const isTerminal = surface === 'terminal'
  const detail = chipDetail(service)
  return (
    <Box
      key={`chip-${service.name}`}
      flexDirection="row"
      paddingX={isTerminal ? 1 : 0}
      backgroundColor={isTerminal ? COLOR.chip : undefined}
    >
      <Text color={statusColor(service)}>{glyphOf(service)} </Text>
      <Text dimColor={!isFailing(service) && !isRunning(service)}>
        {service.name}
      </Text>
      {service.ports.map(port => (
        <Text dimColor>
          :<Link href={`http://localhost:${port}`}>{String(port)}</Link>
        </Text>
      ))}
      {detail && <Text color={statusColor(service)}> {detail}</Text>}
    </Box>
  )
}

function ActionButton(els: Els, action: Action, onPress: (action: Action) => void) {
  const { Button } = els
  return (
    <Button
      key={`act-${action.key}`}
      label={action.label}
      hotkey={action.hotkey}
      variant={action.isPrimary ? 'primary' : undefined}
      onPress={() => onPress(action)}
    />
  )
}

export type BandHandlers = {
  onAction: (action: Action) => void
  /** The corner ×: hides the band until `/docker-panel show`. */
  onClose: () => void
}

/**
 * The desktop's ×. The terminal draws its own `[-]` collapse mark on every band,
 * so a second control there would only crowd it; `/docker-panel hide` remains.
 */
function CloseButton(els: Els, surface: RenderSurface, onClose: () => void) {
  if (surface === 'terminal') return null
  const { Button } = els
  return <Button key="close" label="×" plain role="dismiss" dimColor onPress={onClose} />
}

/** The terminal gets a bordered panel; the desktop frames the band in its own card. */
function frameProps(surface: RenderSurface, color: string) {
  const isTerminal = surface === 'terminal'
  return {
    borderStyle: isTerminal ? 'round' : undefined,
    borderColor: isTerminal ? color : undefined,
    paddingX: isTerminal ? 1 : 0,
  }
}

export function drawBand(els: Els, surface: RenderSurface, panel: Panel, handlers: BandHandlers) {
  const { Box, Text } = els

  if (panel.availability === 'no-daemon' || !panel.snapshot) {
    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" {...frameProps(surface, COLOR.frame)}>
        <Box flexDirection="row">
          <Text color={COLOR.accent}>⬢ docker </Text>
          <Text dimColor>{panel.daemonError ?? 'daemon is not reachable'}</Text>
        </Box>
        {CloseButton(els, surface, handlers.onClose)}
      </Box>
    )
  }

  const snapshot = panel.snapshot
  const isTerminal = surface === 'terminal'
  const severity = severityOf(snapshot)
  const frame = severity === 'failing' ? COLOR.bad : severity === 'stale' ? COLOR.warn : COLOR.frame
  const note = panel.error ?? noteFor(snapshot)
  const noteColor = panel.error || severity === 'failing' ? COLOR.bad : severity === 'stale' ? COLOR.warn : COLOR.idle
  const showsNote = note !== null && severity !== 'down'

  return (
    <Box flexDirection="column" {...frameProps(surface, frame)}>
      <Box key="summary" flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" flexShrink={1} minWidth={0} columnGap={2}>
          <Text bold color={COLOR.accent} wrap="truncate-end">
            ⬢ {snapshot.project}
          </Text>
          <Text dimColor>{upSummary(snapshot)}</Text>
          {panel.stats && severity !== 'down' && <Text dimColor>{formatUsage(panel.stats.total)}</Text>}
          {showsNote && (
            <Text bold={severity === 'failing'} color={noteColor} wrap="truncate-end">
              ▲ {note}
            </Text>
          )}
        </Box>
        <Box flexDirection="row" flexShrink={0} columnGap={1}>
          {panel.busy ? (
            <Text color={COLOR.accent}>… {panel.busy}</Text>
          ) : (
            actionsFor(snapshot).map(action => ActionButton(els, action, handlers.onAction))
          )}
          {CloseButton(els, surface, handlers.onClose)}
        </Box>
      </Box>
      <Box key="services" flexDirection="row" flexWrap="wrap" columnGap={isTerminal ? 1 : 2}>
        {snapshot.services.map(service => Chip(els, surface, service))}
      </Box>
    </Box>
  )
}
